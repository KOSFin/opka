import { describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import {
  invalidateProjectTaskPresentation,
  projectTaskCacheKey,
  projectTaskPresentationIsFresh,
  readProjectTaskPresentation,
  readProjectTaskSelection,
  saveProjectTaskPresentation,
  saveProjectTaskSelection
} from './project-task-presentation-cache'
describe('bounded project task presentation', () => {
  it('retains only in the same client authority generation and host scope', () => {
    let generation = 0
    const client = Object.assign(new FakeSession('connected'), { getGeneration: () => generation })
    const key = projectTaskCacheKey('host', 'report', 'project', 'task', 'revision', 'report.md')
    saveProjectTaskPresentation(
      client,
      key,
      { kind: 'report', project: 'project', report: 'Read-only report' },
      1
    )
    saveProjectTaskSelection(client, 'host', {
      project: 'project',
      taskId: 'task',
      document: 'report.md',
      query: 'Fix',
      phase: 'review',
      source: 'tasks',
      projects: ['project'],
      projectLimit: 16,
      catalogScroll: 48,
      boardScroll: 96
    })
    expect(readProjectTaskPresentation(client, key, 2)?.kind).toBe('report')
    expect(readProjectTaskSelection(client, 'other').project).toBeNull()
    expect(readProjectTaskSelection(client, 'host')).toMatchObject({
      source: 'tasks',
      projects: ['project'],
      catalogScroll: 48,
      boardScroll: 96
    })
    expect(readProjectTaskPresentation(new FakeSession('connected'), key, 2)).toBeNull()
    generation += 1
    expect(readProjectTaskPresentation(client, key, 2)).toBeNull()
    expect(readProjectTaskSelection(client, 'host').project).toBeNull()
  })
  it('bounds fresh and retained ages, count and report bytes', () => {
    const client = new FakeSession('connected')
    const key = projectTaskCacheKey('host', 'report', 'project')
    saveProjectTaskPresentation(
      client,
      key,
      { kind: 'report', project: 'project', report: 'Report' },
      1
    )
    expect(projectTaskPresentationIsFresh(client, key, 59_999)).toBe(true)
    expect(projectTaskPresentationIsFresh(client, key, 60_001)).toBe(false)
    expect(readProjectTaskPresentation(client, key, 600_002)).toBeNull()
    for (let index = 0; index < 25; index += 1) {
      saveProjectTaskPresentation(
        client,
        projectTaskCacheKey('host', 'report', String(index)),
        { kind: 'report', project: String(index), report: 'Report' },
        1
      )
    }
    expect(
      readProjectTaskPresentation(client, projectTaskCacheKey('host', 'report', '0'), 2)
    ).toBeNull()
    saveProjectTaskPresentation(
      client,
      key,
      { kind: 'report', project: 'project', report: 'a'.repeat(1024 * 1024 + 1) },
      1
    )
    expect(readProjectTaskPresentation(client, key, 2)).toBeNull()
  })
  it('invalidates only the mutated project and keeps navigation preferences', () => {
    const client = new FakeSession('connected')
    const key = projectTaskCacheKey('host', 'report', 'project')
    const other = projectTaskCacheKey('other', 'report', 'project')
    for (const target of [key, other]) {
      saveProjectTaskPresentation(client, target, {
        kind: 'report',
        project: 'project',
        report: 'Report'
      })
    }
    saveProjectTaskSelection(client, 'host', {
      project: 'project',
      taskId: null,
      document: null,
      query: 'Fix',
      phase: 'all',
      source: '*',
      projects: ['*'],
      projectLimit: 16,
      catalogScroll: 0,
      boardScroll: 0
    })
    invalidateProjectTaskPresentation(client, 'host', 'project')
    expect(readProjectTaskPresentation(client, key)).toBeNull()
    expect(readProjectTaskPresentation(client, other)?.kind).toBe('report')
    expect(readProjectTaskSelection(client, 'host').query).toBe('Fix')
  })
})
