import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { getGitCloneFailureMessage } from '../../../shared/git-clone-failure-message'
import { gitSpawnAfterWindowsEnvironmentReady, promptGuardGitEnv } from '../../git/runner'
import { reuseSavedCloneTarget } from '../../git/saved-clone-target'
import type { ClaimedCloneTarget } from '../../git/repo-clone-path'
import {
  cleanupClaimedCloneTarget,
  claimCloneTarget,
  deriveValidatedClonePath,
  getClonePathComparisonKey
} from '../../git/repo-clone-path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { emitRepoAdded } from './repo-added-telemetry'
import { runWithClonePathLock } from './clone-path-lock'
import { prepareBoundGitClone } from '../../git/command-runner/bound-git-clone'
import { validateBoundGitCloneSelection } from '../../git/command-runner/bound-git-clone-selection'
import type { BoundGitCloneChoice } from '../../../shared/git-network-binding'
import { registerLocalClonedRepo } from './repo-clone-registration'

type ActiveCloneMetadata = {
  path: string
  pathKey: string
  claimedTarget: ClaimedCloneTarget
  process: ChildProcess
  abortRequested: boolean
  generation: number
  pendingAbortCleanup: Promise<void> | null
  resolvePendingAbortCleanup: (() => void) | null
}

// Why: module-scoped so the abort handle survives macOS window re-creation, when registerRepoHandlers re-runs.
let activeClone: ActiveCloneMetadata | null = null
const pendingLocalCloneControllers = new Set<AbortController>()
let nextCloneGeneration = 1
const latestCloneGenerationByPath = new Map<string, number>()
const pendingAbortCleanupByPath = new Map<string, Promise<void>>()

function emitCloneProgressFromText(mainWindow: BrowserWindow, text: string): void {
  for (const line of text.split(/[\r\n]+/)) {
    const match = line.match(/^([\w\s]+):\s+(\d+)%/)
    if (match && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('repos:clone-progress', {
        phase: match[1].trim(),
        percent: Number.parseInt(match[2], 10)
      })
    }
  }
}

async function cleanupOwnedCloneTarget(metadata: ActiveCloneMetadata): Promise<void> {
  if (!metadata.claimedTarget.canCleanup || !metadata.claimedTarget.ownedDirectoryIdentity) {
    return
  }
  if (latestCloneGenerationByPath.get(metadata.pathKey) !== metadata.generation) {
    return
  }
  // Why: a fast retry may attach a newer process before the aborted one closes; the old close handler must not delete it.
  if (
    activeClone &&
    activeClone.process !== metadata.process &&
    activeClone.pathKey === metadata.pathKey
  ) {
    return
  }

  if (latestCloneGenerationByPath.get(metadata.pathKey) !== metadata.generation) {
    return
  }
  await cleanupClaimedCloneTarget(metadata.path, metadata.claimedTarget)
}

function markCloneAbortCleanupPending(metadata: ActiveCloneMetadata): void {
  if (metadata.resolvePendingAbortCleanup) {
    return
  }
  metadata.pendingAbortCleanup = new Promise<void>((resolve) => {
    metadata.resolvePendingAbortCleanup = resolve
  })
  pendingAbortCleanupByPath.set(metadata.pathKey, metadata.pendingAbortCleanup)
}

function settleCloneAbortCleanup(metadata: ActiveCloneMetadata): void {
  if (pendingAbortCleanupByPath.get(metadata.pathKey) === metadata.pendingAbortCleanup) {
    pendingAbortCleanupByPath.delete(metadata.pathKey)
  }
  metadata.resolvePendingAbortCleanup?.()
  metadata.pendingAbortCleanup = null
  metadata.resolvePendingAbortCleanup = null
}

export function registerRepoCloneHandlers(mainWindow: BrowserWindow, store: Store): void {
  ipcMain.handle('repos:cloneAbort', async () => {
    for (const controller of pendingLocalCloneControllers) {
      controller.abort()
    }
    pendingLocalCloneControllers.clear()
    if (activeClone) {
      const clone = activeClone
      clone.abortRequested = true
      markCloneAbortCleanupPending(clone)
      clone.process.kill()
      activeClone = null
    }
  })

  ipcMain.handle(
    'repos:clone',
    async (
      _event,
      args: { url: string; destination: string; gitNetworkChoice?: BoundGitCloneChoice }
    ): Promise<Repo> => {
      const choice = args.gitNetworkChoice
      if (
        Object.hasOwn(args, 'gitNetworkChoice') &&
        (!choice || (choice.provider !== 'gitlab' && choice.provider !== 'github'))
      ) {
        throw new Error('Selected Git network account is invalid.')
      }
      // Why: derive the repo folder name from the URL's last segment, matching default git clone behavior.
      const clonePath = deriveValidatedClonePath(args)
      const clonePathKey = getClonePathComparisonKey(clonePath)
      // Remote projects can share this path string without belonging to this clone host.
      const findSaved = (): Repo | undefined =>
        store
          .getRepos()
          .find(
            (r) =>
              getClonePathComparisonKey(r.path) === clonePathKey &&
              getRepoExecutionHostId(r) === LOCAL_EXECUTION_HOST_ID
          )
      return runWithClonePathLock(clonePathKey, async () => {
        await pendingAbortCleanupByPath.get(clonePathKey)
        const cloneMetadataRef: { current: ActiveCloneMetadata | null } = { current: null }
        let claimedTarget: ClaimedCloneTarget
        let proc: Awaited<ReturnType<typeof gitSpawnAfterWindowsEnvironmentReady>>
        let boundClone: Awaited<ReturnType<typeof prepareBoundGitClone>> | null = null
        // Why: registered before the saved-project check so Cancel also stops that git read.
        const pendingController = new AbortController()
        pendingLocalCloneControllers.add(pendingController)
        try {
          const reused = await reuseSavedCloneTarget(
            findSaved,
            args.url,
            LOCAL_EXECUTION_HOST_ID,
            pendingController.signal
          )
          if (reused) {
            if (choice) {
              throw new Error('Select the Git network account in the existing repository settings.')
            }
            // Why: clone_url always produces a git repo.
            emitRepoAdded('clone_url', true, true)
            return reused
          }
          if (choice && findSaved()) {
            throw new Error('Select the Git network account in the existing repository settings.')
          }
          const selection = choice ? await validateBoundGitCloneSelection(args.url, choice) : null
          // Why: gitSpawn cwd is args.destination, so it must exist before spawn (fresh installs may lack the defaulted parent).
          await mkdir(args.destination, { recursive: true })
          claimedTarget = await claimCloneTarget(clonePath)
          // Why: spawn (not execFile) avoids the maxBuffer limit — clone progress on stderr can exceed Node's 1 MB default.
          // Why: --progress forces git to emit progress even when stderr isn't a TTY.
          try {
            if (selection) {
              boundClone = await prepareBoundGitClone({
                url: args.url,
                destination: args.destination,
                clonePath,
                claimedTarget,
                selection,
                signal: pendingController.signal
              })
            }
            // Why: use the parent destination as cwd so the runner detects a WSL path and routes through wsl.exe.
            // Why: '--' isolates the URL so a malicious URL can't be read as git flags (command injection).
            proc = await gitSpawnAfterWindowsEnvironmentReady(
              boundClone?.args ?? ['clone', '--progress', '--', args.url, clonePath],
              {
                cwd: args.destination,
                admissionTier: 'interactive',
                // Why: without this, an auth-needing clone pops Git Credential Manager's OAuth window on Windows, unclosable in a restricted env (issue #7652).
                env: boundClone?.env ?? promptGuardGitEnv(),
                signal: pendingController.signal,
                stdio: ['ignore', 'ignore', 'pipe']
              }
            )
          } catch (err) {
            await boundClone?.close()
            await cleanupClaimedCloneTarget(clonePath, claimedTarget)
            const message = err instanceof Error ? err.message : String(err)
            throw new Error(`Clone failed: ${message}`)
          }
        } finally {
          pendingLocalCloneControllers.delete(pendingController)
        }
        pendingLocalCloneControllers.add(pendingController)
        try {
          await new Promise<void>((resolve, reject) => {
            const generation = nextCloneGeneration++
            latestCloneGenerationByPath.set(clonePathKey, generation)
            const metadata: ActiveCloneMetadata = {
              path: clonePath,
              pathKey: clonePathKey,
              claimedTarget,
              process: proc,
              abortRequested: false,
              generation,
              pendingAbortCleanup: null,
              resolvePendingAbortCleanup: null
            }
            cloneMetadataRef.current = metadata
            activeClone = metadata

            let stderrTail = ''
            let settled = false
            proc.stderr!.on('data', (chunk: Buffer) => {
              const text = chunk.toString()
              stderrTail = (stderrTail + text).slice(-4096)

              // Why: git progress lines use \r to overwrite in-place; parse fragments the same as SSH clone.
              emitCloneProgressFromText(mainWindow, text)
            })

            const finishClone = async (
              code: number | null,
              signal: NodeJS.Signals | null,
              err?: Error
            ) => {
              if (settled) {
                return
              }
              settled = true
              // Why: only null activeClone if it still points to this proc; abort-and-retry may have reassigned it, stranding the new clone.
              if (activeClone?.process === proc) {
                activeClone = null
              }

              const cloneSucceeded = !err && code === 0 && !signal
              if (!cloneSucceeded) {
                // Why: only the process that created this target may remove it, and only after git reports failure.
                await cleanupOwnedCloneTarget(metadata)
              }
              if (metadata.abortRequested && !cloneSucceeded) {
                settleCloneAbortCleanup(metadata)
              }
              if (latestCloneGenerationByPath.get(metadata.pathKey) === metadata.generation) {
                latestCloneGenerationByPath.delete(metadata.pathKey)
              }

              if (err) {
                reject(new Error(`Clone failed: ${err.message}`))
              } else if (signal === 'SIGTERM') {
                reject(new Error('Clone aborted'))
              } else if (code === 0) {
                resolve()
              } else {
                reject(
                  new Error(`Clone failed: ${getGitCloneFailureMessage(stderrTail, { clonePath })}`)
                )
              }
            }

            proc.on('error', (err) => {
              void finishClone(null, null, err)
            })

            proc.on('close', (code, signal) => {
              void finishClone(code, signal)
            })
          }).finally(async () => {
            if (boundClone) {
              // The endpoint is closed only after the child has exited.
              await boundClone?.close()
            }
          })

          try {
            return await registerLocalClonedRepo(
              mainWindow,
              store,
              clonePath,
              findSaved,
              boundClone
            )
          } catch (error) {
            if (boundClone && !findSaved()) {
              await cleanupClaimedCloneTarget(clonePath, claimedTarget)
            }
            throw error
          } finally {
            const metadata = cloneMetadataRef.current
            if (metadata?.abortRequested) {
              settleCloneAbortCleanup(metadata)
            }
          }
        } finally {
          pendingLocalCloneControllers.delete(pendingController)
        }
      })
    }
  )
}
