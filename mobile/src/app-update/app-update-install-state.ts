import { useSyncExternalStore } from 'react'

type InstallPhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'cancelling'
  | 'cancelled'
  | 'verifying'
  | 'installer'
  | 'failed'
export type AppUpdateInstallState = {
  phase: InstallPhase
  label: string | null
  busy: boolean
  canCancel: boolean
}
let state: AppUpdateInstallState = { phase: 'idle', label: null, busy: false, canCancel: false }
const listeners = new Set<() => void>()
export function publishAppUpdateInstall(
  phase: InstallPhase,
  label: string | null,
  canCancel = false
): void {
  state = {
    phase,
    label,
    busy: ['preparing', 'downloading', 'cancelling', 'verifying'].includes(phase),
    canCancel: (phase === 'downloading' || phase === 'verifying') && canCancel
  }
  for (const listener of listeners) {
    listener()
  }
}
export function appUpdateInstallBusy(): boolean {
  return state.busy
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function getAppUpdateInstallSnapshot(): AppUpdateInstallState {
  return state
}
export function useAppUpdateInstallState(): AppUpdateInstallState {
  return useSyncExternalStore(subscribe, getAppUpdateInstallSnapshot)
}
