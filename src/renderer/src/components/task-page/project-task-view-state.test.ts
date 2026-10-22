import { afterEach, expect, it, vi } from 'vitest'
import { readProjectTaskView, saveProjectTaskView } from './project-task-view-state'

afterEach(() => vi.unstubAllGlobals())
it('keeps presentation selection and collapse only, and tolerates unavailable or invalid storage', () => {
  const entries = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value)
    }
  })
  saveProjectTaskView({
    workspace: 'folder:fixture',
    selected: 'task-fixture',
    mode: 'tree',
    collapsed: ['task-parent']
  })
  expect(readProjectTaskView()).toEqual({
    workspace: 'folder:fixture',
    selected: 'task-fixture',
    mode: 'tree',
    collapsed: ['task-parent']
  })
  saveProjectTaskView({ mode: 'board' })
  expect(readProjectTaskView().selected).toBe('task-fixture')
  entries.set('orca.projectTask.view.v2', 'invalid json')
  expect(readProjectTaskView().workspace).toBe('')
  vi.stubGlobal('window', {})
  expect(() => saveProjectTaskView({ mode: 'list' })).not.toThrow()
  expect(readProjectTaskView().mode).toBe('board')
})
