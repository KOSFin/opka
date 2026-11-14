import { randomUUID } from 'node:crypto'
import { homedir, constants } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { readProcessStartTimeMs } from './agent-session-process-identity-probe'
import { readPosixProcessRow } from '../provider-process/provider-process-row-read'
import type { z } from 'zod'
import type { NativeCliStdioStart } from '../../shared/native-cli-stdio'
import { nativeCliLaunchArguments } from '../../shared/native-cli-launch-arguments'
import { applyNativeCliAccountEnvironment } from '../../shared/native-cli-account-environment'
import {
  ORCA_AGENT_SESSION_ID_ENV,
  ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV
} from '../../shared/agent-session-caller-env'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import type { ProviderGroupIdentity } from '../provider-process/provider-group-orphan-guard'
import {
  prepareNativeCliAccountLaunch,
  releaseNativeCliAccountLaunch
} from './native-cli-account-launch'
import { stageNativeCliStdioOwner } from './native-cli-stdio-owner'
import { reserveNativeCliStdioLease } from './native-cli-stdio-lease'
import { getRuntimeClaudeNativeLaunchContext } from './runtime-claude-native-sources'
import { readNativeStdioExternalReferences } from './native-stdio-external-references'
import { releaseNativeClaudeRoutingOwner } from './native-claude-routing-ownership'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import { NativeCliStdioSession } from './native-cli-stdio-session'
import type { OrcaRuntimeService } from './orca-runtime'

const sessions = new WeakMap<object, Map<string, NativeCliStdioSession>>()
export function hasNativeCliStdioSessions(runtime: object): boolean {
  return (sessions.get(runtime)?.size ?? 0) > 0
}
export function markNativeCliStdioControlFailure(runtime: object, launchId: string): void {
  sessions.get(runtime)?.get(launchId)?.noteControlFailure()
}
export function requireNativeCliStdioSession(
  runtime: object,
  launchId: string,
  generation: string
) {
  const session = sessions.get(runtime)?.get(launchId)
  if (!session || session.generation !== generation) {
    throw new Error('Native CLI stdio ownership changed.')
  }
  return session
}

export async function startNativeCliStdio(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof NativeCliStdioStart>,
  signal?: AbortSignal
) {
  if (process.platform === 'win32' || !isAbsolute(params.executable) || !isAbsolute(params.cwd)) {
    throw new Error('Native CLI stdio requires a qualified local POSIX executable and directory.')
  }
  if (
    params.args.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) > 1024 * 1024 ||
    Object.entries(params.env).reduce(
      (bytes, pair) => bytes + pair.reduce((n, value) => n + Buffer.byteLength(value), 0),
      0
    ) >
      1024 * 1024
  ) {
    throw new Error('Native CLI launch exceeds its bounded input size.')
  }
  let entries = sessions.get(runtime)
  if (!entries) {
    entries = new Map()
    sessions.set(runtime, entries)
  }
  if (entries.has(params.launchId)) {
    throw new NativeCliControlError('owner_changed')
  }
  const owner = stageNativeCliStdioOwner(runtime, params.launchId)
  let lease: Awaited<ReturnType<typeof reserveNativeCliStdioLease>> | undefined
  const generation = randomUUID()
  const session = new NativeCliStdioSession(generation, owner.retire, async (proven) => {
    await lease?.release(
      proven ? (session.managed?.providerNotStarted ? 'not-started' : 'pid-absent') : 'unverifiable'
    )
    if (
      proven &&
      !(await releaseNativeClaudeRoutingOwner(runtime, params.launchId, {
        ownerAbsent: session.managed?.providerNotStarted ? 'not-started' : 'exited'
      }))
    ) {
      await releaseNativeCliAccountLaunch(runtime, params.launchId)
    }
  })
  entries.set(params.launchId, session)
  let attachDeadline: ReturnType<typeof setTimeout> | undefined
  let spawnInvoked = false
  const abort = () => {
    void session.close().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    const plan = await prepareNativeCliAccountLaunch(
      runtime,
      {
        provider: 'claude',
        launchId: params.launchId,
        claudeExecutable: params.executable,
        stdio: true
      },
      { pendingStdio: true }
    )
    const env = applyNativeCliAccountEnvironment(params.env, plan)
    const context = getRuntimeClaudeNativeLaunchContext(runtime)
    lease = await reserveNativeCliStdioLease(
      runtime,
      params.launchId,
      params.cwd,
      env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
      (sessionId) =>
        context
          ? readNativeStdioExternalReferences(
              {
                db: runtime.openedOrchestrationDb(),
                databasePath: join(context.dataRoot, 'orchestration.db'),
                assertExclusive: context.assertExclusive
              },
              sessionId
            )
          : 'unverifiable'
    )
    env[ORCA_AGENT_SESSION_ID_ENV] = lease.sessionId
    env[ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV] = lease.spawnToken
    delete env.ELECTRON_RUN_AS_NODE
    signal?.throwIfAborted()
    let resolveGroup!: (group: ProviderGroupIdentity) => void
    const groupReady = new Promise<ProviderGroupIdentity>((resolve) => {
      resolveGroup = resolve
    })
    spawnInvoked = true
    const managed = spawnManagedProviderProcess(
      {
        command: params.executable,
        args: nativeCliLaunchArguments('claude', params.args, plan),
        cwd: params.cwd,
        env: Object.fromEntries(
          Object.entries(env).filter((pair): pair is [string, string] => pair[1] !== undefined)
        )
      },
      {
        site: 'native-cli-stdio',
        lifetime: 'one-shot',
        inheritedEnv: {},
        rawOutput: {
          stdout: (bytes) => session.receive('stdout', bytes),
          stderr: (bytes) => session.receive('stderr', bytes),
          onInputError: () => session.noteInputFailure(),
          onOutputError: () => session.noteOutputFailure()
        },
        onGroupProven: (group) => {
          session.group = group
          resolveGroup(group)
        }
      }
    )
    session.managed = managed
    let exitCode = 1
    managed.onExit((exit) => {
      session.exited = true
      owner.retire()
      exitCode = exit.code ?? (exit.signal ? 128 + (constants.signals[exit.signal] ?? 0) : 1)
    })
    managed.child.once('close', () => {
      void session
        .close()
        .then(
          () => session.output.finish(session.outputFailed || session.controlFailed ? 1 : exitCode),
          () => session.output.finish(1)
        )
        .catch(() => {})
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const group = await Promise.race([
        groupReady,
        managed.exitPromise.then(() => null),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Native CLI process proof timed out.')), 5000)
        })
      ])
      if (group && !session.exited) {
        const birth = await readProcessStartTimeMs(group.pgid)
        const row = await readPosixProcessRow(group.pgid)
        if (
          birth === null ||
          !row ||
          row === 'unverifiable' ||
          row.startedAt !== group.startedAt ||
          row.ppid !== managed.child.pid
        ) {
          throw new Error('Native CLI process birth is unverifiable.')
        }
        const heldManaged = managed
        const prove = async () => {
          if (session.exited || heldManaged.rootVerdict !== 'live') {
            return false
          }
          const current = await readPosixProcessRow(group.pgid)
          return (
            !!current &&
            current !== 'unverifiable' &&
            current.startedAt === group.startedAt &&
            current.ppid === heldManaged.child.pid &&
            (await readProcessStartTimeMs(group.pgid)) === birth
          )
        }
        owner.bind(await lease.bind(group.pgid, birth, prove), lease.store, lease.isCurrent)
      }
    } finally {
      clearTimeout(timer)
    }
    signal?.throwIfAborted()
    attachDeadline = setTimeout(() => {
      if (!session.attached) {
        void session
          .close()
          .then((proven) => {
            if (proven) {
              entries.delete(params.launchId)
            }
          })
          .catch(() => {})
      }
    }, 15_000)
    attachDeadline.unref()
    return { launchId: params.launchId, generation }
  } catch (error) {
    if (session.managed) {
      await session.close()
    } else {
      owner.retire()
      await lease?.release(spawnInvoked ? 'unverifiable' : 'not-started')
      if (
        !spawnInvoked &&
        !(await releaseNativeClaudeRoutingOwner(runtime, params.launchId, {
          ownerAbsent: 'not-started'
        }))
      ) {
        await releaseNativeCliAccountLaunch(runtime, params.launchId)
      }
    }
    if (!spawnInvoked || (session.managed && (await session.close()))) {
      entries.delete(params.launchId)
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

export async function stopNativeCliStdioSessions(runtime: object): Promise<void> {
  const entries = sessions.get(runtime)
  for (const session of entries?.values() ?? []) {
    if (!(await session.close())) {
      throw new Error('Native CLI stdio exit remains unverifiable.')
    }
  }
  entries?.clear()
}

export function retireNativeCliStdioTransport(runtime: object, launchId: string) {
  sessions.get(runtime)?.delete(launchId)
}
