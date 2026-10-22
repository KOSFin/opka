// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { mountProbe, unmountProbes } from '../../source-control-hook-test-harness'
import {
  sourceControlViewKey,
  readSourceControlView,
  updateSourceControlView,
  useSourceControlView,
  clearSourceControlViewsForTests
} from './source-control-view-memory'

beforeEach(clearSourceControlViewsForTests)
afterEach(unmountProbes)

it('restores filter, sections and history independently after a keyed remount', async () => {
  let text = ''
  function Probe({ owner }: { owner: string }) {
    const view = useSourceControlView(owner)
    text = JSON.stringify(view)
    return <span>{view.filterQuery}</span>
  }
  const root = await mountProbe(<Probe owner="web" />)
  await act(async () =>
    updateSourceControlView('web', (view) => ({
      ...view,
      filterQuery: 'src',
      filterExpanded: true,
      collapsedSections: ['untracked'],
      collapsedTreeDirs: ['src/legacy'],
      historyHeight: 320,
      expandedCommits: ['oid']
    }))
  )
  const saved = text
  await act(async () => {
    root.render(<Probe key="backend" owner="backend" />)
  })
  expect(text).not.toBe(saved)
  await act(async () => {
    root.render(<Probe key="web" owner="web" />)
  })
  expect(text).toBe(saved)
})

it('isolates the same worktree ID by host, instance and path', () => {
  const local = { target: { kind: 'local' } as const, worktreeId: 'same', path: '/repo' }
  const keys = [
    sourceControlViewKey(local),
    sourceControlViewKey({ ...local, target: { kind: 'environment', environmentId: 'remote' } }),
    sourceControlViewKey({ ...local, instanceId: 'replacement' }),
    sourceControlViewKey({ ...local, path: '/moved' })
  ]
  expect(new Set(keys).size).toBe(4)
  updateSourceControlView(keys[0], (view) => ({ ...view, filterQuery: 'local' }))
  expect(readSourceControlView(keys[1]).filterQuery).toBe('')
  expect(sourceControlViewKey({ ...local, worktreeId: null })).toBeNull()
})

it('evicts old presentation rather than growing with unlimited worktrees', () => {
  for (let i = 0; i < 513; i++) {
    updateSourceControlView(String(i), (view) => ({ ...view, filterQuery: String(i) }))
  }
  expect(readSourceControlView('0').filterQuery).toBe('')
  expect(readSourceControlView('512').filterQuery).toBe('512')
})
