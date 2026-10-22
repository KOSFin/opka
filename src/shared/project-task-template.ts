import { stringify } from 'yaml'

export function projectTaskTemplate(input: {
  id: string
  title: string
  detailed?: boolean
  repos?: string[]
  goal?: string
}): string {
  const metadata = stringify({
    schema: 1,
    id: input.id,
    title: input.title,
    kind: 'implementation',
    parent: null,
    depends_on: [],
    repos: input.repos ?? []
  }).trimEnd()
  return `---\n${metadata}\n---\n# Goal\n${input.goal?.trim() || input.title}\n\n## Scope\nWork within this project. Confirm external writes separately.\n\n## Acceptance\n- [ ] Describe a verifiable outcome.\n\n## Plan\n- [ ] Inspect the relevant code and constraints.\n- [ ] Implement and verify the change.\n${input.detailed ? '\n## Decisions\nLink detailed findings and notes.md.\n\n## Delivery\nRecord repository, base/head SHA, review and validation links.\n\n## Next step\nWrite checkpoint.md before handing work to a new session.\n' : ''}`
}
