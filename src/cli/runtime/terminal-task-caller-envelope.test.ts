import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { writeSecureJsonFile } from '../../shared/secure-file'
import { terminalTaskCallerPath } from '../../shared/terminal-task-caller-file'
import { TERMINAL_TASK_CALLER_FILE_ENV } from '../../shared/terminal-task-caller-env'
import { redactOrchestrationCompatibilitySecrets } from '../../shared/orchestration-compatibility-evidence'
import { createOrchestrationCompatibilityEnvelope } from './orchestration-compatibility-envelope'

let root: string
let env: NodeJS.ProcessEnv
const identity = {
  terminalHandle: 'term_owned',
  paneKey: 'tab_owned:pane',
  worktreeId: 'folder:synthetic',
  processIncarnation: 'pty:incarnation'
}
const proof = 'a'.repeat(64)
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opka-caller-envelope-'))
  const path = terminalTaskCallerPath(root, 'synthetic-pty')
  writeSecureJsonFile(path, { schema: 1, proof, identity })
  env = { ORCA_USER_DATA_PATH: root, [TERMINAL_TASK_CALLER_FILE_ENV]: path }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('adds only sealed task proof to a filtered command caller and redacts it from diagnostics', () => {
  const evidence = createOrchestrationCompatibilityEnvelope(env).orchestrationCompatibilityEvidence
  expect(evidence).toEqual({
    terminalHandle: identity.terminalHandle,
    paneKey: identity.paneKey,
    terminalTaskProof: proof
  })
  expect(redactOrchestrationCompatibilitySecrets(evidence)).toMatchObject({
    terminalTaskProof: '[redacted]'
  })
})

it('keeps structured-session identity authoritative', () => {
  expect(
    createOrchestrationCompatibilityEnvelope({
      ...env,
      ORCA_AGENT_SESSION_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }).orchestrationCompatibilityEvidence
  ).toEqual({ agentSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
})

it('does not turn a foreign-host envelope into a local caller', () => {
  expect(
    createOrchestrationCompatibilityEnvelope({
      ...env,
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'wsl',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'local',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'Ubuntu'
    }).orchestrationCompatibilityEvidence
  ).toEqual({ host: { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' } })
})

it('refuses an unsealed file and another profile', () => {
  expect(
    createOrchestrationCompatibilityEnvelope({ ...env, ORCA_USER_DATA_PATH: join(root, 'other') })
      .orchestrationCompatibilityEvidence
  ).toBeUndefined()
  writeSecureJsonFile(env[TERMINAL_TASK_CALLER_FILE_ENV]!, { schema: 1, proof })
  expect(
    createOrchestrationCompatibilityEnvelope(env).orchestrationCompatibilityEvidence
  ).toBeUndefined()
})
