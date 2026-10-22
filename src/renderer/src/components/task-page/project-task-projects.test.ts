import { expect, it } from 'vitest'
import {
  projectTaskError,
  projectTaskRows,
  taskProjectKey,
  taskViewKey,
  type TaskProjectView
} from './project-task-projects'

it('qualifies identical tasks and roots by their actual host and project', () => {
  const local = taskProjectKey({ kind: 'local' }, '/workspace')
  const remote = taskProjectKey({ kind: 'environment', environmentId: 'server' }, '/workspace')
  expect(local).not.toBe(remote)
  const makeView = (key: string): TaskProjectView => ({
    scope: {
      key,
      root: '/workspace',
      name: 'Project',
      hostLabel: key,
      selector: 'folder:x',
      state: 'configured',
      target: { kind: 'local' }
    },
    board: {
      project: { id: key, schema: 1, repos: { root: '.' }, sources: [] },
      executionHostId: 'local',
      total: 1,
      diagnostics: [],
      tasks: [
        {
          schema: 1,
          id: 'same-task',
          title: 'Same name',
          kind: 'implementation',
          parent: null,
          depends_on: [],
          repos: ['root'],
          revision: 'a'.repeat(64),
          source: 'project',
          path: 'tasks/task.md',
          workflow: {
            taskId: 'same-task',
            phase: 'draft',
            archived: false,
            approvedRevision: null,
            revisionChanged: false,
            attempts: [],
            events: [],
            exportError: null,
            recordedSequence: 0
          }
        }
      ]
    }
  })
  const rows = projectTaskRows([makeView(local), makeView(remote)], true)
  expect(rows[0].id).toBe(rows[1].id)
  expect(taskViewKey(rows[0])).not.toBe(taskViewKey(rows[1]))
  expect(rows.every((row) => row.projectLabel)).toBe(true)
})
it('distinguishes missing config, unsupported peers and connection failure', () => {
  expect(projectTaskError(new Error("ENOENT: lstat '/project/.orca/project.yaml'"))).toContain(
    'not set up'
  )
  expect(projectTaskError(new Error('method_not_found'))).toContain('newer fork version')
  expect(projectTaskError(new Error('connection timeout'))).toContain('Reconnect')
  expect(projectTaskError(new Error('Invalid project schema'))).toBe('Invalid project schema')
})
