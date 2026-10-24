import { app } from 'electron'

declare const __OPKA_MAC_MANUAL_INSTALLER__: boolean

export function usesManualMacInstaller(): boolean {
  return (
    process.platform === 'darwin' &&
    app.isPackaged &&
    // oxlint-disable-next-line unicorn/no-typeof-undefined -- This compile-time macro does not exist in unbundled unit tests.
    typeof __OPKA_MAC_MANUAL_INSTALLER__ !== 'undefined' &&
    __OPKA_MAC_MANUAL_INSTALLER__
  )
}
