import { describe, expect, it } from 'vitest'
import { mobileConnectionPathLabel } from './mobile-connection-path-label'

describe('mobile connection path label', () => {
  it('distinguishes LAN, Tailscale, and the relay without exposing transport errors', () => {
    expect(mobileConnectionPathLabel('lan')).toBe('Direct · LAN')
    expect(mobileConnectionPathLabel('tailscale')).toBe('Direct · VPN')
    expect(mobileConnectionPathLabel('tailscale', 'ws://100.64.1.2:6769')).toBe('Direct · VPN')
    expect(mobileConnectionPathLabel('tailscale', 'wss://desk.test.ts.net')).toBe(
      'Direct · Tailscale'
    )
    expect(mobileConnectionPathLabel('relay')).toBe('Orca Relay')
  })
})
