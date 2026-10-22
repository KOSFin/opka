import { expect, it } from 'vitest'
import { projectTaskRepositories } from './project-task-placement'
import { projectTaskTemplate } from './project-task-template'
import { parseProjectTask } from '../main/project-tasks/task-document'

it('creates a project-wide task without forcing repository choices and preserves explicit scopes', () => {
  const task = parseProjectTask(
    projectTaskTemplate({
      id: 'task-11111111-1111-4111-8111-111111111111',
      title: 'Full project outcome',
      goal: 'Repair web and backend together'
    })
  )
  expect(task.repos).toEqual([])
  expect(task.body).toContain('Repair web and backend together')
  const project = {
    schema: 1 as const,
    id: 'project-test',
    repos: { web: 'apps/web', backend: 'services/backend' },
    sources: []
  }
  expect(projectTaskRepositories(task, project)).toEqual(['web', 'backend'])
  expect(projectTaskRepositories({ repos: ['web'] }, project)).toEqual(['web'])
})
