// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { useTaskPageRepoSelection } from './use-task-page-repo-selection'

const hostA: Repo = {
  id: 'host-a-repo',
  path: '/fixture/a',
  displayName: 'A',
  badgeColor: '',
  addedAt: 1,
  executionHostId: 'runtime:host-a',
  kind: 'git'
}
const hostB: Repo = {
  id: 'host-b-repo',
  path: '/fixture/b',
  displayName: 'B',
  badgeColor: '',
  addedAt: 2,
  executionHostId: 'runtime:host-b',
  kind: 'git'
}

afterEach(cleanup)

function mountSelection(settings: Partial<GlobalSettings> = {}) {
  const updateSettings = vi.fn(async () => {})
  const model = {
    repos: [hostA, hostB],
    settings,
    pageData: {},
    linearStatus: {},
    jiraStatus: {},
    preflightStatus: null,
    preflightStatusCurrent: true,
    linearConnected: false,
    updateSettings
  }
  const hook = renderHook(() => useTaskPageRepoSelection(model))
  return { ...hook, updateSettings }
}

it('keeps each provider’s host-specific checkout through A → B → A and saves both', () => {
  const { result, updateSettings } = mountSelection()
  act(() => {
    void result.current.saveRepoSelection(new Set([hostA.id]))
  })
  act(() => result.current.setTaskSource('gitlab'))
  expect([...result.current.repoSelection]).toEqual([hostA.id, hostB.id])
  act(() => {
    void result.current.saveRepoSelection(new Set([hostB.id]))
  })
  expect([...result.current.repoSelection]).toEqual([hostB.id])
  expect(result.current.selectedRepos.map((repo) => repo.id)).toEqual([hostB.id])
  act(() => result.current.setTaskSource('github'))
  expect([...result.current.repoSelection]).toEqual([hostA.id])
  expect(result.current.selectedRepos.map((repo) => repo.id)).toEqual([hostA.id])
  expect(updateSettings).toHaveBeenLastCalledWith({
    defaultRepoSelections: { local: { github: [hostA.id], gitlab: [hostB.id] } }
  })
})

it('restores saved provider selections, including sticky all, without inheriting the legacy GitHub value', () => {
  const { result } = mountSelection({
    defaultRepoSelection: [hostA.id],
    defaultRepoSelections: { local: { github: [hostB.id], gitlab: null } }
  })
  expect([...result.current.repoSelection]).toEqual([hostB.id])
  act(() => result.current.setTaskSource('gitlab'))
  expect([...result.current.repoSelection]).toEqual([hostA.id, hostB.id])
  act(() => result.current.setTaskSource('github'))
  expect([...result.current.repoSelection]).toEqual([hostB.id])
})

it('uses the legacy selection for GitHub only and saves explicit all independently', () => {
  const { result, updateSettings } = mountSelection({
    activeRuntimeEnvironmentId: 'host-b',
    defaultRepoSelection: [hostB.id]
  })
  expect([...result.current.repoSelection]).toEqual([hostB.id])
  act(() => result.current.setTaskSource('gitlab'))
  expect([...result.current.repoSelection]).toEqual([hostA.id, hostB.id])
  act(() => {
    void result.current.saveRepoSelection(null)
  })
  expect(updateSettings).toHaveBeenLastCalledWith({
    defaultRepoSelections: { 'host-b': { gitlab: null } }
  })
})

it('applies a hydrated provider selection before the next repo-backed render', () => {
  let settings: Partial<GlobalSettings> | null = null
  const { result, rerender } = renderHook(() => {
    const model = {
      repos: [hostA, hostB],
      settings,
      pageData: {},
      linearStatus: {},
      jiraStatus: {},
      preflightStatus: null,
      preflightStatusCurrent: true,
      linearConnected: false,
      updateSettings: vi.fn()
    }
    return useTaskPageRepoSelection(model)
  })
  expect(result.current.selectedRepos.map((repo) => repo.id)).toEqual([hostA.id, hostB.id])
  settings = { defaultRepoSelections: { local: { github: [hostB.id] } } }
  rerender()
  expect(result.current.selectedRepos.map((repo) => repo.id)).toEqual([hostB.id])
})

it('restores separate selections after focused runtime host A → B → A', () => {
  let settings: Partial<GlobalSettings> = {
    activeRuntimeEnvironmentId: 'host-a',
    defaultRepoSelections: {
      'host-a': { github: [hostA.id] },
      'host-b': { github: [hostB.id] }
    }
  }
  const { result, rerender } = renderHook(() => {
    const model = {
      repos: [hostA, hostB],
      settings,
      pageData: {},
      linearStatus: {},
      jiraStatus: {},
      preflightStatus: null,
      preflightStatusCurrent: true,
      linearConnected: false,
      updateSettings: vi.fn()
    }
    return useTaskPageRepoSelection(model)
  })
  expect(result.current.selectedRepos.map((repo) => repo.id)).toEqual([hostA.id])
  settings = { ...settings, activeRuntimeEnvironmentId: 'host-b' }
  rerender()
  expect(result.current.selectedRepos.map((repo) => repo.id)).toEqual([hostB.id])
  settings = { ...settings, activeRuntimeEnvironmentId: 'host-a' }
  rerender()
  expect(result.current.selectedRepos.map((repo) => repo.id)).toEqual([hostA.id])
})
