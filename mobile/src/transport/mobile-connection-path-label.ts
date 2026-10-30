import type { MobileConnectionPath } from './stable-logical-rpc-client'
import { endpointOverlayLabel } from '../../../src/shared/remote-runtime-tailscale-hint'

export function mobileConnectionPathLabel(path: MobileConnectionPath, endpoint?: string): string {
  if (path === 'relay') {
    return 'Orca Relay'
  }
  return path === 'tailscale'
    ? `Direct · ${endpointOverlayLabel(endpoint) ?? 'VPN'}`
    : 'Direct · LAN'
}
