import { useCallback } from 'react'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { mobileAccountsRouteTarget, type MobileAccountsUsageIntent } from './mobile-accounts-route'

export function useOpenMobileAccounts(): (
  hostId: string,
  usage?: MobileAccountsUsageIntent
) => void {
  const openHostStackRoute = useOpenHostStackRoute()

  return useCallback(
    (hostId, usage) => {
      openHostStackRoute(hostId, mobileAccountsRouteTarget(hostId, usage))
    },
    [openHostStackRoute]
  )
}
