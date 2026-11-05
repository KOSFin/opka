import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

type ScreenTestState = {
  current: string
  appListener: ((value: string) => void) | null
  focus: (() => () => void) | null
}

const state = vi.hoisted((): ScreenTestState => ({
  current: 'active',
  appListener: null,
  focus: null
}))
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return state.current
    },
    addEventListener: (_name: string, listener: (value: string) => void) => {
      state.appListener = listener
      return {
        remove: () => {
          state.appListener = null
        }
      }
    }
  }
}))
vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => () => void) => {
    state.focus = callback
  }
}))
import { useScreenActive } from './use-screen-active'
import { useNow } from './use-now'

describe('retained screen activity', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    vi.useRealTimers()
  })

  it('stops clocks on blur/background and retains mounted state on return', () => {
    vi.useFakeTimers()
    let active = false
    let retained: object | null = null
    let tick = 0
    function Screen() {
      active = useScreenActive()
      const [value] = useState({ draft: 'unsaved' })
      retained = value
      tick = useNow(1000, active)
      return null
    }
    act(() => {
      renderer = create(createElement(Screen))
    })
    const original = retained
    let blur: (() => void) | undefined
    act(() => {
      blur = state.focus?.()
    })
    expect(active).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    act(() => {
      blur?.()
    })
    expect(active).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    const paused = tick
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(tick).toBe(paused)
    act(() => {
      blur = state.focus?.()
    })
    expect(retained).toBe(original)
    expect(vi.getTimerCount()).toBe(1)
    act(() => {
      state.current = 'background'
      state.appListener?.('background')
    })
    expect(active).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      state.current = 'active'
      state.appListener?.('active')
    })
    expect(active).toBe(true)
    expect(retained).toBe(original)
    expect(vi.getTimerCount()).toBe(1)
  })
})
