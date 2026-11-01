import { parseDocument } from 'yaml'
import { projectTaskTemplate } from '../../../src/shared/project-task-template'

export function createMobileTaskContent(
  id: string,
  title: string,
  goal: string,
  acceptance: string
) {
  const criteria = acceptance
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!title.trim() || !goal.trim() || criteria.length === 0) {
    throw new Error('Add a title, a goal and at least one acceptance criterion.')
  }
  return projectTaskTemplate({ id, title: title.trim(), goal }).replace(
    '- [ ] Describe a verifiable outcome.',
    criteria.map((line) => `- [ ] ${line}`).join('\n')
  )
}

export function updateMobileTaskContent(content: string, title: string, body: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match || !title.trim()) {
    throw new Error('Task metadata is unavailable. Refresh before editing.')
  }
  const document = parseDocument(match[1])
  if (document.errors.length) {
    throw new Error('Task metadata could not be read. Open it on desktop.')
  }
  document.set('title', title.trim())
  return `---\n${document.toString().trimEnd()}\n---\n${body.trim()}\n`
}
