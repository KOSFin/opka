import { describe, expect, it } from 'vitest'
import { parseProjectTask, parseTaskProject, taskRevision } from './task-document'

const id = 'task-11111111-1111-4111-8111-111111111111'
const document = `---\nschema: 1\nid: ${id}\ntitle: Repair pipeline\nkind: implementation\nrepos: [backend]\ndepends_on: []\n---\n# Goal\nKeep this text.\n\n## Custom section\nDo not lose me.\n`

describe('project task documents', () => {
  it('keeps the complete source and unknown prose while validating metadata', () => {
    const task = parseProjectTask(document)
    expect(task.id).toBe(id)
    expect(task.content).toBe(document)
    expect(task.revision).toBe(taskRevision(document))
    expect(task.body).toContain('## Custom section')
  })

  it.each([
    document.replace('schema: 1', 'schema: 2'),
    document.replace('title: Repair pipeline', 'title: one\ntitle: two'),
    document.replace('kind: implementation', 'kind: !!js/function "evil"'),
    document.replace('depends_on: []', `depends_on: [${id}]`),
    document.replace('repos: [backend]', 'repos: [backend]\nstatus: completed'),
    document.replace('repos: [backend]', 'repos: [backend]\nextra: &x [*x]')
  ])('rejects invalid/future/unsafe metadata without executing it', (content) => {
    expect(() => parseProjectTask(content)).toThrow()
  })

  it('accepts CRLF documents and rejects empty or oversized bodies', () => {
    expect(parseProjectTask(document.replaceAll('\n', '\r\n')).id).toBe(id)
    expect(() => parseProjectTask('# Just a note')).toThrow()
    expect(() => parseProjectTask(document + 'x'.repeat(262_144))).toThrow()
  })

  it('supports shared and per-repository roots without escaping the project', () => {
    const project = {
      schema: 1,
      id: 'project-11111111-1111-4111-8111-111111111111',
      repos: { backend: 'backend', root: '.' },
      sources: [
        { id: 'shared', path: 'docs/work/tasks' },
        { id: 'backend', path: 'backend/docs/tasks' }
      ]
    }
    expect(parseTaskProject(JSON.stringify(project)).sources).toHaveLength(2)
    for (const path of ['../outside', '/tmp/tasks', 'C:/tasks', 'docs\\tasks', '.git/tasks']) {
      expect(() =>
        parseTaskProject(JSON.stringify({ ...project, sources: [{ id: 'bad', path }] }))
      ).toThrow()
    }
    expect(() =>
      parseTaskProject(
        JSON.stringify({ ...project, sources: [project.sources[0], project.sources[0]] })
      )
    ).toThrow()
  })
})
