import { expect, it } from 'vitest'
import {
  taskProjectPickerLabel,
  taskProjectPickerSections,
  toggleTaskProject,
  toggleTaskProjectGroup
} from './ProjectTaskProjectPicker'
import type { TaskProjectScope } from './project-task-projects'

const projects = [{ key: 'local' }, { key: 'ssh' }, { key: 'folder' }]

it('selects and deselects all projects without losing host-scoped keys', () => {
  expect(toggleTaskProject(['*'], projects, 'ssh')).toEqual(['local', 'folder'])
  expect(toggleTaskProject(['local'], projects, 'ssh')).toEqual(['local', 'ssh'])
  expect(toggleTaskProject(['local', 'ssh'], projects, 'local')).toEqual(['ssh'])
  expect(toggleTaskProject([], projects, '*')).toEqual(['*'])
  expect(toggleTaskProject(['*'], projects, '*')).toEqual([])
})

it('counts a grouped project once and names partial repository selection honestly', () => {
  const roots: TaskProjectScope[] = [
    {
      key: 'web',
      selector: 'path:/web',
      root: '/web',
      name: 'web',
      state: 'configured',
      target: { kind: 'local' },
      hostLabel: 'This computer',
      groupId: 'studio',
      groupName: 'Studio',
      repositoryName: 'web'
    },
    {
      key: 'cli',
      selector: 'path:/cli',
      root: '/cli',
      name: 'cli',
      state: 'configured',
      target: { kind: 'local' },
      hostLabel: 'This computer',
      groupId: 'studio',
      groupName: 'Studio',
      repositoryName: 'cli'
    },
    {
      key: 'docs',
      selector: 'folder:/docs',
      root: '/docs',
      name: 'Docs',
      state: 'configured',
      target: { kind: 'local' },
      hostLabel: 'This computer'
    }
  ]
  expect(taskProjectPickerLabel(roots, ['web', 'cli'])).toBe('Studio')
  expect(taskProjectPickerLabel(roots, ['web'])).toBe('Studio · partial')
  expect(taskProjectPickerLabel(roots, ['web', 'docs'])).toBe('2 projects · partial')
  expect(taskProjectPickerLabel(roots, ['web', 'cli', 'docs'])).toBe('All projects')
  expect(taskProjectPickerLabel(roots, [])).toBe('0 projects')
})

it('groups repository task roots by their actual host and project while retaining root selection', () => {
  const roots: TaskProjectScope[] = [
    {
      key: 'local-web',
      selector: 'path:/web',
      root: '/web',
      name: 'web',
      state: 'configured',
      target: { kind: 'local' },
      hostLabel: 'This computer',
      groupId: 'project',
      groupName: 'First project',
      repositoryName: 'web'
    },
    {
      key: 'local-cli',
      selector: 'path:/cli',
      root: '/cli',
      name: 'cli',
      state: 'configured',
      target: { kind: 'local' },
      hostLabel: 'This computer',
      groupId: 'project',
      groupName: 'First project',
      repositoryName: 'cli'
    },
    {
      key: 'remote-web',
      selector: 'path:/web',
      root: '/web',
      name: 'web',
      state: 'configured',
      target: { kind: 'environment', environmentId: 'remote' },
      hostLabel: 'Remote',
      groupId: 'project',
      groupName: 'Second project',
      repositoryName: 'web'
    }
  ]
  expect(
    taskProjectPickerSections(roots).map((section) => [
      section.name,
      section.projects.map((project) => project.key)
    ])
  ).toEqual([
    ['First project', ['local-web', 'local-cli']],
    ['Second project', ['remote-web']]
  ])
  expect(toggleTaskProjectGroup([], roots, ['local-web', 'local-cli'])).toEqual([
    'local-web',
    'local-cli'
  ])
  expect(toggleTaskProjectGroup(['*'], roots, ['local-web', 'local-cli'])).toEqual(['remote-web'])
})
