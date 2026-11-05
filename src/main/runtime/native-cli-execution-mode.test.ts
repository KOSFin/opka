import { beforeEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import { nativeCliExecutionMode } from './native-cli-execution-mode'
import { verifyProjectTaskTerminalProof } from './project-task-terminal-proof'
vi.mock('./project-task-terminal-proof', () => ({ verifyProjectTaskTerminalProof: vi.fn() }))
const host: Pick<OrcaRuntimeService, 'getOrchestrationDispatchAuthority'> = {
  getOrchestrationDispatchAuthority: vi.fn()
}
const parentTerminal = {
  terminalHandle: 'term-parent',
  paneKey: 'pane-parent',
  terminalTaskProof: 'a'.repeat(64)
}
beforeEach(() => vi.resetAllMocks())
it('uses a host PTY only for an external interactive shell without managed identity', () => {
  expect(nativeCliExecutionMode(host, { interactive: true })).toBe('host-pty')
  expect(nativeCliExecutionMode(host, {})).toBe('inherit')
  expect(verifyProjectTaskTerminalProof).not.toHaveBeenCalled()
})
it('keeps a verified existing pane in inherited stdio so its task and hooks retain their identity', () => {
  vi.mocked(verifyProjectTaskTerminalProof).mockReturnValue({
    hostScope: { kind: 'local', hostId: 'local' },
    terminalHandle: 'term-parent',
    paneKey: 'pane-parent',
    processIncarnation: 'incarnation',
    launchTokenHash: 'synthetic'
  })
  expect(
    nativeCliExecutionMode(host, { interactive: true, parentTerminal, parentContextExpected: true })
  ).toBe('inherit')
  expect(verifyProjectTaskTerminalProof).toHaveBeenCalledWith(host, parentTerminal)
})
it('refuses invalid proof instead of creating a floating replacement', () => {
  vi.mocked(verifyProjectTaskTerminalProof).mockReturnValue(null)
  expect(() => nativeCliExecutionMode(host, { interactive: true, parentTerminal })).toThrow(
    'could not verify'
  )
})
it('refuses an expected managed context when its proof is missing', () => {
  expect(() =>
    nativeCliExecutionMode(host, { interactive: true, parentContextExpected: true })
  ).toThrow('unverifiable')
})
