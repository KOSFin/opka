import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const activity = vi.hoisted(() => ({
  state: 'active',
  listeners: new Set<(state: string) => void>()
}))
vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: unknown }): unknown =>
    React.createElement('Text', props, children)
  return {
    AppState: {
      get currentState() {
        return activity.state
      },
      addEventListener: (_event: string, listener: (state: string) => void) => {
        activity.listeners.add(listener)
        return {
          remove: () => {
            activity.listeners.delete(listener)
          }
        }
      }
    },
    ActivityIndicator: (props: Record<string, unknown>) =>
      React.createElement('ActivityIndicator', props),
    Pressable: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('Pressable', props, children),
    Text,
    View: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight' }))

import { MobileNativeChatTurnStatus } from './MobileNativeChatTurnStatus'

const labels = (node: ReactTestInstance): string[] =>
  node.findAllByType('Text' as never).map((text) => String(text.children.join('')))

const spinners = (node: ReactTestInstance): ReactTestInstance[] =>
  node.findAllByType('ActivityIndicator' as never)

let renderer: ReactTestRenderer | null = null

beforeEach(() => {
  activity.state = 'active'
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-04T00:00:00Z'))
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  vi.useRealTimers()
})

describe('MobileNativeChatTurnStatus', () => {
  function render(props: {
    startedAt: number | null
    workedSeconds?: number | null
    verdict?: 'interruption' | 'cancellation'
    expanded?: boolean
    onToggleExpanded?: () => void
  }): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatTurnStatus, props))
    })
    return renderer!
  }

  it('counts up from the first second while the turn runs, with no spinner', () => {
    const tree = render({ startedAt: Date.now() })
    expect(labels(tree.root)).toEqual(['Working for 0s'])
    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(labels(tree.root)).toEqual(['Working for 12s'])
    expect(spinners(tree.root)).toHaveLength(0)
  })

  it('settles to a tappable "Worked for" row that toggles the turn', () => {
    const onToggleExpanded = vi.fn()
    const tree = render({ startedAt: Date.now(), workedSeconds: 184, onToggleExpanded })
    expect(labels(tree.root)).toEqual(['Worked for 3m 4s'])
    const button = tree.root.findByType('Pressable' as never)
    expect(button.props.accessibilityLabel).toBe('Toggle turn details')
    expect(button.props.accessibilityState).toEqual({ expanded: false })
    act(() => button.props.onPress())
    expect(onToggleExpanded).toHaveBeenCalledOnce()
  })

  // The crash's notice row explains the cut; the turn bar reads like any finished turn.
  it('heads a turn a crash cut off as worked, and a turn the user stopped as interrupted', () => {
    const crashed = render({
      startedAt: Date.now(),
      workedSeconds: 12,
      verdict: 'interruption',
      onToggleExpanded: vi.fn()
    })
    expect(labels(crashed.root)).toEqual(['Worked for 12s'])
    act(() => crashed.unmount())
    const stopped = render({
      startedAt: Date.now(),
      workedSeconds: 12,
      verdict: 'cancellation',
      onToggleExpanded: vi.fn()
    })
    expect(labels(stopped.root)).toEqual(['Interrupted after 12s'])
  })

  it('stays a plain row when the settled turn has nothing to disclose', () => {
    const tree = render({ startedAt: Date.now(), workedSeconds: 5 })
    expect(tree.root.findAllByType('Pressable' as never)).toHaveLength(0)
    expect(labels(tree.root)).toEqual(['Worked for 5s'])
  })

  it('holds no interval once the turn has settled', () => {
    render({ startedAt: Date.now(), workedSeconds: 5 })
    expect(vi.getTimerCount()).toBe(0)
  })
})

it('pauses elapsed-time wakeups in background and releases every subscription on close', () => {
  const startedAt = Date.now()
  act(() => {
    renderer = create(createElement(MobileNativeChatTurnStatus, { startedAt }))
  })
  expect(vi.getTimerCount()).toBe(1)
  for (let cycle = 0; cycle < 5; cycle++) {
    act(() => {
      activity.state = 'background'
      for (const listener of activity.listeners) {
        listener('background')
      }
    })
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    act(() => {
      activity.state = 'active'
      for (const listener of activity.listeners) {
        listener('active')
      }
    })
    expect(vi.getTimerCount()).toBe(1)
  }
  act(() => renderer?.unmount())
  renderer = null
  expect(vi.getTimerCount()).toBe(0)
  expect(activity.listeners.size).toBe(0)
})
