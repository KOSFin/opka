import { afterEach, expect, it, vi } from 'vitest'
import { readProjectTaskView, saveProjectTaskView } from './project-task-view-state'

afterEach(() => vi.unstubAllGlobals())
it('restores selected projects, filters, selection and scroll, and tolerates invalid storage', () => {
  const entries = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value)
    }
  })
  saveProjectTaskView({
    workspace: 'folder:fixture',
    projectKeys: ['folder:fixture', 'folder:other'],
    selected: 'task-fixture',
    mode: 'tree',
    collapsed: ['task-parent'],
    query: 'blocked',
    listScrollTop: 240
  })
  expect(readProjectTaskView()).toMatchObject({
    projectKeys: ['folder:fixture', 'folder:other'],
    selected: 'task-fixture',
    mode: 'tree',
    collapsed: ['task-parent'],
    query: 'blocked',
    listScrollTop: 240
  })
  saveProjectTaskView({ mode: 'board' })
  expect(readProjectTaskView().selected).toBe('task-fixture')
  entries.set('orca.projectTask.view.v2', JSON.stringify({ workspace: 'folder:legacy' }))
  expect(readProjectTaskView().projectKeys).toEqual(['folder:legacy'])
  entries.set('orca.projectTask.view.v2', 'invalid json')
  expect(readProjectTaskView().workspace).toBe('')
  vi.stubGlobal('window', {})
  expect(() => saveProjectTaskView({ mode: 'list' })).not.toThrow()
  expect(readProjectTaskView().mode).toBe('board')
})
