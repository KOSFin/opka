import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileHomeEmptyState } from './MobileHomeEmptyState'

const update = vi.hoisted(() => ({ open: vi.fn(), dismiss: vi.fn() }))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ArrowUpFromLine: 'ArrowUpFromLine',
  QrCode: 'QrCode',
  X: 'X'
}))
vi.mock('../app-update/app-update-runtime', () => ({
  appUpdateChecker: { dismiss: update.dismiss },
  cancelAppUpdate: vi.fn(),
  openAppUpdate: update.open,
  useAppUpdateState: () => ({
    available: { version: '1.4.236-rc.6', url: 'https://example.test/latest-android.json' },
    dismissedVersion: null
  })
}))
vi.mock('../app-update/app-update-install-state', () => ({
  useAppUpdateInstallState: () => ({ busy: false, label: null })
}))

describe('unpaired home updates', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  it('offers the real update action alongside desktop pairing before any host is saved', () => {
    const pair = vi.fn()
    act(() => {
      renderer = create(
        createElement(MobileHomeEmptyState, {
          bottomInset: 0,
          contentMaxWidth: 600,
          isWideLayout: false,
          onPairDesktop: pair
        })
      )
    })
    const root = renderer!.root
    const text = root
      .findAll((node) => String(node.type) === 'Text')
      .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
    expect(text).toContain('Connect your desktop')
    expect(text).toContain('Pair Desktop')
    expect(text).toContain('Orca 1.4.236-rc.6 is available')
    const buttons = root.findAll((node) => String(node.type) === 'Pressable')
    const updateButton = buttons.find(
      (node) => node.props.accessibilityLabel === 'Orca 1.4.236-rc.6 is available, tap to update'
    )
    expect(updateButton).toBeDefined()
    act(() => updateButton?.props.onPress())
    expect(update.open).toHaveBeenCalledWith('https://example.test/latest-android.json')
    const pairButton = buttons.find((node) => node.props.onPress === pair)
    act(() => pairButton?.props.onPress())
    expect(pair).toHaveBeenCalledOnce()
  })
})
