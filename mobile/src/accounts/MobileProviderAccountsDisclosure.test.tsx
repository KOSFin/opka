import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('../components/AgentIcons', () => ({ ClaudeIcon: 'ClaudeIcon', OpenAIIcon: 'OpenAIIcon' }))
vi.mock('lucide-react-native', () => ({ ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight' }))

import { MobileProviderAccountsDisclosure } from './MobileProviderAccountsDisclosure'

let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
})

it('keeps provider account addition inside the initially collapsed fallback section', async () => {
  await act(async () => {
    tree = create(
      createElement(
        MobileProviderAccountsDisclosure,
        { provider: 'codex' },
        createElement('Text', null, 'Add Codex account')
      )
    )
  })
  const toggle = tree!.root.findByType('Pressable')
  expect(toggle.props.accessibilityState.expanded).toBe(false)
  expect(JSON.stringify(tree!.toJSON())).not.toContain('Add Codex account')
  await act(async () => toggle.props.onPress())
  expect(toggle.props.accessibilityState.expanded).toBe(true)
  expect(JSON.stringify(tree!.toJSON())).toContain('Add Codex account')
})
