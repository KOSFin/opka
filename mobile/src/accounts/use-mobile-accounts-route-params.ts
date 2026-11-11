import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import type { MobileAccountsUsageRouteParams } from './mobile-accounts-route'

export function useMobileAccountsRouteParams(): {
  hostId: string
  usageParams: MobileAccountsUsageRouteParams
} {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    usageHostId?: string | string[]
    usageProvider?: string | string[]
    usageAccountId?: string | string[]
    usageRuntimeKey?: string | string[]
  }>()
  return {
    hostId: firstParam(params.hostId),
    usageParams: {
      usageHostId: firstParam(params.usageHostId),
      usageProvider: firstParam(params.usageProvider),
      usageAccountId: firstParam(params.usageAccountId),
      usageRuntimeKey: firstParam(params.usageRuntimeKey)
    }
  }
}
