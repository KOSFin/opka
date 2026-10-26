import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  readInjectedTerminalTaskCaller,
  readTerminalTaskCallerFile
} from '../../shared/terminal-task-caller-file'
import { TERMINAL_TASK_CALLER_FILE_ENV } from '../../shared/terminal-task-caller-env'
import {
  prepareTerminalTaskCaller,
  publishTerminalTaskCaller,
  retireTerminalTaskCaller,
  verifyProjectTaskTerminalProof
} from './project-task-terminal-proof'
import { OrcaRuntimeService } from './orca-runtime'

let root: string
let runtime: OrcaRuntimeService
const identity = {
  terminalHandle: 'term_owned',
  paneKey: 'tab_fixture:77777777-7777-4777-8777-777777777777',
  worktreeId: 'folder:fixture',
  processIncarnation: 'pty-fixture:incarnation'
}
let path: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opka-terminal-proof-'))
  vi.spyOn(getAppEnvironment(), 'getPath').mockReturnValue(root)
  runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
    handle === identity.terminalHandle
      ? {
          runtimeId: 'runtime-fixture',
          terminalHandle: handle,
          ptyId: 'pty-fixture',
          worktreeId: identity.worktreeId,
          processIncarnation: identity.processIncarnation,
          paneKey: identity.paneKey,
          launchTokenHash: null,
          hostScope: { kind: 'local', hostId: 'local' }
        }
      : null
  )
  const prepared = prepareTerminalTaskCaller(root, 'pty-fixture')
  if (!prepared) {
    throw new Error('Synthetic caller file not prepared')
  }
  path = prepared
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function evidence() {
  const record = readInjectedTerminalTaskCaller({
    ORCA_USER_DATA_PATH: root,
    [TERMINAL_TASK_CALLER_FILE_ENV]: path
  })
  return record?.identity
    ? {
        terminalHandle: record.identity.terminalHandle,
        paneKey: record.identity.paneKey,
        terminalTaskProof: record.proof
      }
    : undefined
}

it('does not admit a placeholder before host registration seals its process identity', () => {
  expect(evidence()).toBeUndefined()
  expect(verifyProjectTaskTerminalProof(runtime, evidence())).toBeNull()
})

it('recovers only task caller proof after all secret environment variables are filtered', () => {
  publishTerminalTaskCaller('pty-fixture', identity)
  const proof = evidence()
  expect(proof).toMatchObject({
    terminalHandle: identity.terminalHandle,
    paneKey: identity.paneKey
  })
  expect(proof).not.toHaveProperty('launchToken')
  expect(verifyProjectTaskTerminalProof(runtime, proof)).toMatchObject({
    processIncarnation: identity.processIncarnation
  })
  expect(runtime.verifyOrchestrationCompatibilityCaller(proof)).toBeNull()
})

it('preserves the nonce on a verified reattach but never reseals it for a replacement process', () => {
  publishTerminalTaskCaller('pty-fixture', identity)
  const original = readFileSync(path, 'utf8')
  publishTerminalTaskCaller('pty-fixture', {
    ...identity,
    processIncarnation: 'pty-fixture:replacement'
  })
  expect(readFileSync(path, 'utf8')).toBe(original)
  publishTerminalTaskCaller('pty-fixture', { ...identity, terminalHandle: 'term_reattached' })
  expect(readTerminalTaskCallerFile(path)?.proof).toBe(JSON.parse(original).proof)
  expect(evidence()?.terminalHandle).toBe('term_reattached')
  expect(verifyProjectTaskTerminalProof(runtime, evidence())).toBeNull()
})

it('only retires proof for the exact certified process incarnation', () => {
  publishTerminalTaskCaller('pty-fixture', identity)
  retireTerminalTaskCaller('pty-fixture', 'pty-fixture:old')
  expect(readTerminalTaskCallerFile(path)?.identity).toEqual(identity)
  retireTerminalTaskCaller('pty-fixture', identity.processIncarnation)
  expect(readTerminalTaskCallerFile(path)).toBeNull()
})

it.each([
  { terminalHandle: 'term_other' },
  { paneKey: 'other-pane' },
  { terminalTaskProof: '0'.repeat(64) },
  { host: { kind: 'wsl' as const, hostId: 'local', distro: 'Ubuntu' } }
])('refuses changed caller evidence %j', (change) => {
  publishTerminalTaskCaller('pty-fixture', identity)
  expect(verifyProjectTaskTerminalProof(runtime, { ...evidence(), ...change })).toBeNull()
})

it('refuses a live terminal whose process incarnation no longer matches the sealed proof', () => {
  publishTerminalTaskCaller('pty-fixture', identity)
  const terminal = runtime.getOrchestrationDispatchAuthority(identity.terminalHandle)
  if (!terminal) {
    throw new Error('Missing synthetic authority')
  }
  vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue({
    ...terminal,
    processIncarnation: 'pty-fixture:new'
  })
  expect(verifyProjectTaskTerminalProof(runtime, evidence())).toBeNull()
})

it('does not import another profile', () => {
  publishTerminalTaskCaller('pty-fixture', identity)
  expect(
    readInjectedTerminalTaskCaller({
      ORCA_USER_DATA_PATH: join(root, 'other'),
      [TERMINAL_TASK_CALLER_FILE_ENV]: path
    })
  ).toBeNull()
})

it.skipIf(process.platform === 'win32')('refuses symlinks and group-readable files', () => {
  publishTerminalTaskCaller('pty-fixture', identity)
  chmodSync(path, 0o644)
  expect(readTerminalTaskCallerFile(path)).toBeNull()
  const content = readFileSync(path)
  rmSync(path)
  const target = join(root, 'private-copy')
  writeFileSync(target, content, { mode: 0o600 })
  symlinkSync(target, path)
  expect(readTerminalTaskCallerFile(path)).toBeNull()
  expect(prepareTerminalTaskCaller(root, 'pty-fixture')).toBeNull()
})

it.skipIf(process.platform === 'win32')('never replaces a dangling caller-file symlink', () => {
  rmSync(path)
  symlinkSync(join(root, 'missing-target'), path)
  expect(prepareTerminalTaskCaller(root, 'pty-fixture')).toBeNull()
})
