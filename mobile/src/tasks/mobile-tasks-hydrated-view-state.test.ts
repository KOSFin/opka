import { describe, expect, it, vi } from 'vitest'
vi.mock('./mobile-tasks-dependencies', async () => ({
  resolveVisibleTaskProvider: (await import('../../../src/shared/task-providers'))
    .resolveVisibleTaskProvider,
  colors: (await import('../theme/mobile-theme')).colors
}))
vi.mock('./mobile-tasks-legacy-foundation', async () => import('./mobile-tasks-item-mapping'))
import { resolveHydratedTaskViewState } from './mobile-tasks-hydrated-view-state'
describe('GitLab saved task preferences', () => {
  it('restores GitLab view, state and search through existing TaskResumeState', () => {
    expect(
      resolveHydratedTaskViewState({
        settings: {},
        resume: { gitlabView: 'project', gitlabFilter: 'closed', gitlabQuery: 'release' },
        requestedTaskSource: 'gitlab',
        visibleProviders: ['gitlab']
      })
    ).toMatchObject({
      provider: 'gitlab',
      gitlabView: 'project',
      gitlabFilter: 'closed',
      query: 'release',
      appliedQuery: 'release'
    })
  })
  it('does not carry invisible item search into Todos and supports older settings', () => {
    const base = {
      settings: {},
      requestedTaskSource: 'gitlab' as const,
      visibleProviders: ['gitlab' as const]
    }
    expect(
      resolveHydratedTaskViewState({
        ...base,
        resume: { gitlabView: 'todos', gitlabQuery: 'old search' }
      })
    ).toMatchObject({ gitlabView: 'todos', query: '', appliedQuery: '' })
    expect(resolveHydratedTaskViewState({ ...base, resume: {} })).toMatchObject({
      gitlabView: 'project',
      gitlabFilter: 'opened',
      query: ''
    })
  })
})
