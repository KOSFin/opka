import { OrchestrationDb } from './orchestration/db/orchestration-db'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { armNativeCliStartup } from './native-cli-startup'
import { getAppEnvironment } from '../../shared/app-environment'
import { prepareTerminalTaskCaller, publishTerminalTaskCaller } from './project-task-terminal-proof'
import { readTerminalTaskCallerFile } from '../../shared/terminal-task-caller-file'
import type { NativeCliAccountLaunchV2Request } from '../../shared/native-cli-account-launch'

class StartupRuntime extends OrcaRuntimeService {
  record() {
    return this.recordPtyWorktree('pty:synthetic', 'folder:synthetic', {
      connected: true,
      incarnationId: 'raw:synthetic',
      paneKey: 'tab_fixture:77777777-7777-4777-8777-777777777777',
      tabId: 'tab_fixture'
    })
  }
}
export function nativeCliStartupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'opka-startup-'))
  vi.spyOn(getAppEnvironment(), 'getPath').mockReturnValue(root)
  const runtime = new StartupRuntime()
  const db = new OrchestrationDb(':memory:')
  vi.spyOn(runtime, 'getOrchestrationDb').mockReturnValue(db)
  const pty = runtime.record()
  pty.launchToken = 'synthetic-token'
  pty.launchIncarnationId = pty.incarnationId
  pty.launchAgent = 'codex'
  armNativeCliStartup(pty)
  const identity = {
    terminalHandle: 'term_synthetic',
    worktreeId: pty.worktreeId,
    paneKey: pty.paneKey ?? '',
    processIncarnation: `${pty.ptyId}:${pty.incarnationId}`
  }
  const authority = {
    runtimeId: 'runtime-synthetic',
    ...identity,
    ptyId: pty.ptyId,
    launchTokenHash: createHash('sha256').update(pty.launchToken).digest('hex'),
    hostScope: { kind: 'local', hostId: 'local' } as const
  }
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
    handle === identity.terminalHandle ? authority : null
  )
  vi.spyOn(runtime, 'resolveTerminalPane').mockImplementation(() => ({
    handle: identity.terminalHandle,
    tabId: 'tab_fixture',
    leafId: '77777777-7777-4777-8777-777777777777',
    ptyId: pty.ptyId,
    worktreeId: pty.worktreeId,
    connected: pty.connected,
    executionHostId: 'local',
    incarnationId: pty.incarnationId
  }))
  const path = prepareTerminalTaskCaller(root, pty.ptyId)
  if (!path) {
    throw new Error('Synthetic proof creation failed')
  }
  publishTerminalTaskCaller(pty.ptyId, identity)
  const record = readTerminalTaskCallerFile(path)
  if (!record?.identity || !pty.nativeCliStartup) {
    throw new Error('Synthetic proof publication failed')
  }
  const request: NativeCliAccountLaunchV2Request = {
    provider: 'codex',
    launchId: '12345678-1234-4234-8234-123456789012',
    parentTerminal: {
      terminalHandle: identity.terminalHandle,
      paneKey: identity.paneKey,
      terminalTaskProof: record.proof
    },
    startup: { version: 1, launchToken: pty.launchToken }
  }
  return {
    runtime,
    db,
    pty,
    authority,
    root,
    path,
    request,
    startup: pty.nativeCliStartup,
    dispose: () => {
      pty.nativeCliStartup?.finish('unconfirmed')
      db.close()
      vi.restoreAllMocks()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
