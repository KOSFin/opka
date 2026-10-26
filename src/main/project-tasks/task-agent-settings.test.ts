import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { configureTaskAgentSettings, readTaskAgentSettings } from './task-agent-settings'
import { TASK_AGENT_SKILL_PATHS } from './task-agent-integration'
import { TaskWorkspace } from './task-workspace'
import { PROJECT_TASK_SKILL } from '../../shared/project-task-skill'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opka-board-settings-'))
  roots.push(root)
  return root
}

it('reads missing integration without writes, then enables it by default without changing user instructions', async () => {
  const root = await fixture()
  await writeFile(join(root, 'AGENTS.md'), 'User instructions')
  expect(await readTaskAgentSettings(root)).toMatchObject({ enabled: true, state: 'needs-repair' })
  await expect(stat(join(root, '.agents'))).rejects.toThrow()
  const installed = await configureTaskAgentSettings(root, 'reconcile')
  expect(installed).toMatchObject({ enabled: true, state: 'enabled' })
  expect(installed.files.every((file) => file.state === 'installed')).toBe(true)
  const before = await stat(join(root, '.orca/task-agent-settings.json'))
  expect(await configureTaskAgentSettings(root, 'reconcile')).toEqual(installed)
  expect((await stat(join(root, '.orca/task-agent-settings.json'))).mtimeMs).toBe(before.mtimeMs)
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('User instructions')
})

it('keeps disable across a new workspace and reconciliation; the legacy enable action still works', async () => {
  const root = await fixture()
  const workspace = new TaskWorkspace(root)
  await workspace.initialize()
  expect(await workspace.agentSettings()).toMatchObject({ state: 'enabled' })
  expect(await workspace.agentSettings('disable')).toMatchObject({
    enabled: false,
    state: 'disabled'
  })
  const reopened = new TaskWorkspace(root)
  expect(await reopened.agentSettings('reconcile')).toMatchObject({
    enabled: false,
    state: 'disabled'
  })
  for (const path of TASK_AGENT_SKILL_PATHS) {
    await expect(stat(join(root, path))).rejects.toThrow()
  }
  expect(await reopened.enableAgentTasks()).toEqual({ paths: TASK_AGENT_SKILL_PATHS })
  expect(await reopened.agentSettings()).toMatchObject({ enabled: true, state: 'enabled' })
  await Promise.all([workspace.close(), reopened.close()])
})

it('does not overwrite or delete custom instructions, including on automatic setup', async () => {
  const root = await fixture()
  await configureTaskAgentSettings(root, 'enable')
  const customPath = join(root, TASK_AGENT_SKILL_PATHS[1])
  await writeFile(customPath, 'User skill')
  expect(await configureTaskAgentSettings(root, 'reconcile')).toMatchObject({ state: 'customized' })
  for (const action of ['enable', 'disable'] as const) {
    await expect(configureTaskAgentSettings(root, action)).rejects.toThrow(/preserved/)
  }
  expect(await readFile(customPath, 'utf8')).toBe('User skill')
  expect(await readFile(join(root, TASK_AGENT_SKILL_PATHS[0]), 'utf8')).toBe(PROJECT_TASK_SKILL)
})

it('repairs a missing managed skill without changing installed files or reenabling an explicit opt-out', async () => {
  const root = await fixture()
  await configureTaskAgentSettings(root, 'enable')
  const untouched = await stat(join(root, TASK_AGENT_SKILL_PATHS[0]))
  await unlink(join(root, TASK_AGENT_SKILL_PATHS[1]))
  expect(await readTaskAgentSettings(root)).toMatchObject({ state: 'needs-repair' })
  expect(await configureTaskAgentSettings(root, 'reconcile')).toMatchObject({ state: 'enabled' })
  expect((await stat(join(root, TASK_AGENT_SKILL_PATHS[0]))).mtimeMs).toBe(untouched.mtimeMs)
  await configureTaskAgentSettings(root, 'disable')
  await writeFile(join(root, TASK_AGENT_SKILL_PATHS[0]), PROJECT_TASK_SKILL)
  expect(await readTaskAgentSettings(root)).toMatchObject({ enabled: false, state: 'needs-repair' })
  expect(await configureTaskAgentSettings(root, 'reconcile')).toMatchObject({
    enabled: false,
    state: 'disabled'
  })
})

it('fails closed for invalid preference files and symlinked instruction directories', async () => {
  const root = await fixture()
  await mkdir(join(root, '.orca'))
  await writeFile(join(root, '.orca/task-agent-settings.json'), '{"schema":1,"enabled":"false"}')
  await expect(configureTaskAgentSettings(root, 'reconcile')).rejects.toThrow()
  await expect(stat(join(root, '.agents'))).rejects.toThrow()
  const other = await fixture()
  const outside = await fixture()
  await symlink(outside, join(other, '.agents'))
  await expect(configureTaskAgentSettings(other, 'reconcile')).rejects.toThrow(/symlink/)
  await expect(stat(join(outside, 'skills'))).rejects.toThrow()
})
