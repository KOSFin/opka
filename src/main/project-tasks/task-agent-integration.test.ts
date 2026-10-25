import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { installProjectTaskAgentIntegration } from './task-agent-integration'
import { taskDocuments } from './task-documents'
import { PROJECT_TASK_SKILL } from '../../shared/project-task-skill'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opka-task-integration-'))
  roots.push(root)
  return root
}

it('installs identical project-scoped skills idempotently without changing user instructions', async () => {
  const root = await fixture()
  await writeFile(join(root, 'AGENTS.md'), 'User instructions')
  const first = await installProjectTaskAgentIntegration(root)
  expect(await installProjectTaskAgentIntegration(root)).toEqual(first)
  for (const path of first.paths) {
    expect(await readFile(join(root, path), 'utf8')).toBe(PROJECT_TASK_SKILL)
  }
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('User instructions')
})

it('preserves a custom skill and refuses a symlinked skill directory', async () => {
  const root = await fixture()
  await mkdir(join(root, '.claude/skills/opka-tasks'), { recursive: true })
  await writeFile(join(root, '.claude/skills/opka-tasks/SKILL.md'), 'Custom skill')
  await expect(installProjectTaskAgentIntegration(root)).rejects.toThrow(/preserved/)
  await expect(readFile(join(root, '.agents/skills/opka-tasks/SKILL.md'))).rejects.toThrow()
  expect(await readFile(join(root, '.claude/skills/opka-tasks/SKILL.md'), 'utf8')).toBe(
    'Custom skill'
  )
  const outside = await fixture()
  const other = await fixture()
  await symlink(outside, join(other, '.agents'))
  await expect(installProjectTaskAgentIntegration(other)).rejects.toThrow(/symlink/)
})

it('reads only documents of the selected task and rejects unrelated paths or symlinks', async () => {
  const root = await fixture()
  const task = 'docs/work/tasks/one/task.md'
  expect((await taskDocuments(root, task)).paths).toEqual([])
  await mkdir(join(root, 'docs/work/tasks/one/reports'), { recursive: true })
  await writeFile(join(root, 'docs/work/tasks/one/reports/result.md'), 'Verified result')
  await writeFile(join(root, 'docs/work/tasks/one/notes.md'), 'Notes')
  const report = 'docs/work/tasks/one/reports/result.md'
  expect(await taskDocuments(root, task, report)).toMatchObject({
    path: report,
    content: 'Verified result'
  })
  await expect(taskDocuments(root, task, '../outside.md')).rejects.toThrow(/belonging/)
  await symlink(
    join(root, 'docs/work/tasks/one/notes.md'),
    join(root, 'docs/work/tasks/one/checkpoint.md')
  )
  await expect(taskDocuments(root, task)).rejects.toThrow(/symlink/)
})
