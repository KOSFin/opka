import { useSyncExternalStore } from 'react'

type InstallPhase = 'idle' | 'preparing' | 'downloading' | 'verifying' | 'installer' | 'failed'
export type AppUpdateInstallState = {
  phase: InstallPhase
  label: string | null
  busy: boolean
}
let state: AppUpdateInstallState = { phase: 'idle', label: null, busy: false }
const listeners = new Set<() => void>()
export function publishAppUpdateInstall(phase: InstallPhase, label: string | null): void {
  state = { phase, label, busy: ['preparing', 'downloading', 'verifying'].includes(phase) }
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
