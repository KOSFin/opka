import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { projectTaskTemplate } from '../../../src/shared/project-task-template'

export async function probeRemoteProjectTask(page: Page, environmentId: string, root: string) {
  const id = `task-${randomUUID()}`,
    slug = randomUUID()
  await page.evaluate(
    async ({ environmentId, root, id, slug, content }) => {
      const worktree = `path:${root}`
      const call = async (method: string, params: object = {}) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: `projectTask.${method}`,
          params: { worktree, ...params }
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        return response.result
      }
      const host = await call('target')
      if (
        !host ||
        typeof host !== 'object' ||
        !('executionHostId' in host) ||
        typeof host.executionHostId !== 'string'
      ) {
        throw new Error('Remote owner was not established')
      }
      const expectedExecutionHostId = host.executionHostId
      try {
        await call('init', { expectedExecutionHostId })
      } catch (error) {
        if (!(error instanceof Error && error.message.includes('configuration already exists'))) {
          throw error
        }
      }
      const task = await call('create', {
        expectedExecutionHostId,
        source: 'project',
        slug,
        content
      })
      if (
        !task ||
        typeof task !== 'object' ||
        !('revision' in task) ||
        typeof task.revision !== 'string'
      ) {
        throw new Error('Remote document was not created')
      }
      await call('approve', { expectedExecutionHostId, id, revision: task.revision })
      const board = await call('board', { offset: 0, limit: 100 })
      if (
        !board ||
        typeof board !== 'object' ||
        !('tasks' in board) ||
        !Array.isArray(board.tasks) ||
        !board.tasks.some((row) => typeof row === 'object' && row !== null && row.id === id)
      ) {
        throw new Error('Remote board did not expose its task')
      }
      const resume = await call('resume', { id })
      if (
        !resume ||
        typeof resume !== 'object' ||
        !('text' in resume) ||
        typeof resume.text !== 'string' ||
        !resume.text.includes('Current plan approved: true')
      ) {
        throw new Error('Remote resume did not restore approval')
      }
      await call('archive', {
        expectedExecutionHostId,
        id,
        revision: task.revision,
        archived: true
      })
    },
    {
      environmentId,
      root,
      id,
      slug,
      content: projectTaskTemplate({ id, title: 'Isolated remote project task probe' })
    }
  )
  return { id, worktree: `path:${root}` }
}

export async function verifyRemoteProjectTaskResume(
  page: Page,
  environmentId: string,
  task: { id: string; worktree: string }
): Promise<void> {
  await page.evaluate(
    async ({ environmentId, task }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'projectTask.resume',
        params: task
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      if (
        !response.result ||
        typeof response.result !== 'object' ||
        !('text' in response.result) ||
        typeof response.result.text !== 'string' ||
        !response.result.text.includes(task.id)
      ) {
        throw new Error('Remote task context was lost on reconnect')
      }
    },
    { environmentId, task }
  )
}
