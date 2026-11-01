import { useNow } from '../hooks/use-now'
import { useAppUpdateInstallState } from '../app-update/app-update-install-state'
import { useEffect, useState } from 'react'
import {
  appUpdateChecker,
  installedAppVersion,
  openAppUpdate,
  useAppUpdateState
} from '../app-update/app-update-runtime'
import { AppUpdateSettingsRows, type AppUpdateCheckRowStatus } from './app-update-settings-rows'

const CHECK_RESULT_VISIBLE_MS = 3000
const RELATIVE_TIME_TICK_MS = 60_000

export function SettingsAppUpdateSection() {
  const install = useAppUpdateInstallState()
  const state = useAppUpdateState()
  const [result, setResult] = useState<'up-to-date' | 'failed' | null>(null)
  // A check newer than this reads as "just now", so the tick only has to age the label.
  const now = useNow(RELATIVE_TIME_TICK_MS)

  useEffect(() => {
    if (result === null) {
      return
    }
    const hide = setTimeout(() => setResult(null), CHECK_RESULT_VISIBLE_MS)
    return () => clearTimeout(hide)
  }, [result])

  const runCheck = () => {
    setResult(null)
    void appUpdateChecker.checkNow().then((outcome) => {
      // An available update shows in the row above, so only the other outcomes need words here.
      setResult(outcome === 'available' ? null : outcome)
    })
  }

  const checkStatus: AppUpdateCheckRowStatus = state.checking ? 'checking' : (result ?? 'idle')
  return (
    <AppUpdateSettingsRows
      installedVersion={installedAppVersion}
      installBusy={install.busy}
      installLabel={install.label}
      available={state.available}
      lastCheckedAt={state.lastCheckedAt}
      now={now}
      checkStatus={checkStatus}
      onUpdate={openAppUpdate}
      onCheck={runCheck}
    />
  )
}
