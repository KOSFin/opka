import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { writeSecureJsonFile } from '../../shared/secure-file'
import { restrictWindowsPathSync } from '../../shared/secure-path-windows-acl'
import {
  readTerminalTaskCallerFile,
  terminalTaskCallerPath,
  type TerminalTaskCallerRecord
} from '../../shared/terminal-task-caller-file'
import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { OrcaRuntimeService } from './orca-runtime'
import type { OrchestrationCompatibilityCallerAuthority } from './runtime-terminal-contracts'

function writablePath(path: string): boolean {
  for (const target of [dirname(path), path]) {
    try {
      const stats = lstatSync(target)
      if (stats.isSymbolicLink() || (target === path ? !stats.isFile() : !stats.isDirectory())) {
        return false
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        return false
      }
    }
  }
  return true
}

export function prepareTerminalTaskCaller(profile: string, ptyId: string): string | null {
  const path = terminalTaskCallerPath(profile, ptyId)
  try {
    if (!lstatSync(profile).isDirectory() || !writablePath(path)) {
      return null
    }
    return writeSecureJsonFile(path, { schema: 1, proof: randomBytes(32).toString('hex') })
      ? path
      : null
  } catch {
    return null
  }
}

export function publishTerminalTaskCaller(
  ptyId: string,
  identity: NonNullable<TerminalTaskCallerRecord['identity']>
): void {
  if (!hasAppEnvironment()) {
    return
  }
  const path = terminalTaskCallerPath(getAppEnvironment().getPath('userData'), ptyId)
  const prior = readTerminalTaskCallerFile(path)
  if (
    !prior ||
    (prior.identity &&
      (prior.identity.processIncarnation !== identity.processIncarnation ||
        prior.identity.paneKey !== identity.paneKey ||
        prior.identity.worktreeId !== identity.worktreeId))
  ) {
    return
  }
  if (JSON.stringify(prior.identity) === JSON.stringify(identity)) {
    return
  }
  try {
    if (writablePath(path) && !writeSecureJsonFile(path, { ...prior, identity })) {
      unlinkSync(path)
    }
  } catch {
    // A credential-store failure must not terminate the user's terminal.
  }
}

export function retireTerminalTaskCaller(ptyId: string, processIncarnation: string): void {
  if (!hasAppEnvironment()) {
    return
  }
  const path = terminalTaskCallerPath(getAppEnvironment().getPath('userData'), ptyId)
  const record = readTerminalTaskCallerFile(path)
  if (record?.identity?.processIncarnation === processIncarnation) {
    try {
      unlinkSync(path)
    } catch {
      /* Already removed or inaccessible; the live-PTY fence still refuses it. */
    }
  }
}

export function verifyProjectTaskTerminalProof(
  runtime: OrcaRuntimeService,
  evidence: OrchestrationCompatibilityEvidence | undefined
): OrchestrationCompatibilityCallerAuthority | null {
  if (evidence?.host || !evidence?.terminalHandle || !evidence.terminalTaskProof) {
    return null
  }
  const terminal = runtime.getOrchestrationDispatchAuthority(evidence.terminalHandle)
  if (
    !terminal?.processIncarnation ||
    terminal.hostScope.kind !== 'local' ||
    terminal.paneKey !== evidence.paneKey
  ) {
    return null
  }
  const path = terminalTaskCallerPath(getAppEnvironment().getPath('userData'), terminal.ptyId)
  const record = readTerminalTaskCallerFile(path)
  if (record && process.platform === 'win32' && !restrictWindowsPathSync(path, false)) {
    return null
  }
  if (
    !record?.identity ||
    record.proof !== evidence.terminalTaskProof ||
    record.identity.terminalHandle !== terminal.terminalHandle ||
    record.identity.paneKey !== terminal.paneKey ||
    record.identity.worktreeId !== terminal.worktreeId ||
    record.identity.processIncarnation !== terminal.processIncarnation
  ) {
    return null
  }
  return Object.freeze({
    hostScope: terminal.hostScope,
    terminalHandle: terminal.terminalHandle,
    paneKey: terminal.paneKey,
    processIncarnation: terminal.processIncarnation,
    launchTokenHash: createHash('sha256').update(record.proof).digest('hex')
  })
}
