import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'
import { dispatch } from '../dispatch'
import { parseArgs } from '../args'
import { PROJECT_TASK_DELEGATION_CAPABILITY } from '../../shared/project-task-delegation'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function setup(supported = true) {
  const root = await mkdtemp(join(tmpdir(), 'task-delegation-cli-'))
  roots.push(root)
  const file = join(root, 'request.json')
  await writeFile(
    file,
    JSON.stringify({
      id: 'synthetic-task',
      revision: 'a'.repeat(64),
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
  )
  const client = new RuntimeClient()
  const call = vi.spyOn(client, 'call').mockImplementation(async (method) => ({
    id: 'request',
    ok: true,
    result:
      method === 'status.get'
        ? { capabilities: supported ? [PROJECT_TASK_DELEGATION_CAPABILITY] : [] }
        : method === 'projectTask.target'
          ? { executionHostId: 'local' }
          : {},
    _meta: { runtimeId: 'synthetic' }
  }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const run = (action: string) =>
    dispatch(['project-task', 'delegated'], {
      client,
      cwd: root,
      json: true,
      flags: new Map([
        ['action', action],
        ['file', file],
        ['worktree', 'folder:synthetic']
      ])
    })
  return { client, call, run, root }
}
it('negotiates owning-host support, keeps verified identity, and never invokes manual approval', async () => {
  vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
  vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term-own')
  const h = await setup()
  await h.run('approve-plan')
  expect(h.call).toHaveBeenLastCalledWith(
    'projectTask.approveDelegated',
    expect.objectContaining({
      from: 'term-own',
      capability: PROJECT_TASK_DELEGATION_CAPABILITY,
      expectedExecutionHostId: 'local'
    })
  )
  expect(h.call.mock.calls.some(([method]) => method === 'projectTask.approve')).toBe(false)
})
it('refuses an old host before sending any delegated/manual mutation', async () => {
  const h = await setup(false)
  await expect(h.run('approve-plan')).rejects.toMatchObject({ code: 'incompatible_runtime' })
  expect(h.call).toHaveBeenCalledTimes(1)
})
it('does not expose policy issuance via agent command and parses delegated lifecycle flag as boolean', async () => {
  const h = await setup()
  await expect(h.run('install')).rejects.toMatchObject({ code: 'invalid_argument' })
  expect(h.call.mock.calls.some(([method]) => method.startsWith('projectTask.policy.'))).toBe(false)
  expect(
    parseArgs(['--delegated', 'project-task', 'claim', '--id', 'one']).flags.get('delegated')
  ).toBe(true)
})
