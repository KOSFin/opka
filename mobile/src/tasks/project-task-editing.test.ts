import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { createMobileTaskContent, updateMobileTaskContent } from './project-task-editing'

describe('mobile project task editing', () => {
  it('requires a meaningful goal and acceptance before creating a task', () => {
    expect(() => createMobileTaskContent('task-1', 'Fix', '', 'check')).toThrow('goal')
    const content = createMobileTaskContent(
      'task-1',
      'Fix parser',
      'Preserve Unicode',
      'Round trip Russian\nReject invalid input'
    )
    expect(content).toContain('- [ ] Round trip Russian')
    expect(content).toContain('- [ ] Reject invalid input')
  })
  it('preserves task identity, dependencies and repository scope when editing title/body', () => {
    const original =
      '---\nschema: 1\nid: task-1\ntitle: Original\ndepends_on: [task-2]\nrepos: [backend]\n---\nOld plan'
    const next = updateMobileTaskContent(original, 'New title', '# Goal\nNew plan')
    const metadata = parse(next.split('---')[1])
    expect(metadata).toMatchObject({
      id: 'task-1',
      title: 'New title',
      depends_on: ['task-2'],
      repos: ['backend']
    })
    expect(next.endsWith('# Goal\nNew plan\n')).toBe(true)
  })
  it('does not invent metadata for an old host returning only a task body', () => {
    expect(() => updateMobileTaskContent('# Old body', 'New title', 'New plan')).toThrow('metadata')
  })
})
