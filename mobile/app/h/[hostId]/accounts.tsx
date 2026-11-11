import { useLocalSearchParams } from 'expo-router'
import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'
import {
  shellScreenRoute,
  shellScreenRouteKey
} from '../../../src/mobile-web-shell/shell-screen-route'
import { PageRouteUnavailableScreen } from '../../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { firstParam } from '../../../src/navigation/route-param-reader'

/** The shell route for the host's agent accounts, in `tasks.tsx`'s shape. */
export default function MobileAccountsRoute() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    usageHostId?: string | string[]
    usageProvider?: string | string[]
    usageAccountId?: string | string[]
    usageRuntimeKey?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const usageProvider = firstParam(params.usageProvider)

  const route = hostId
    ? shellScreenRoute({
        pathname: `/h/${encodeURIComponent(hostId)}/accounts`,
        ...(usageProvider
          ? {
              params: {
                usageHostId: firstParam(params.usageHostId),
                usageProvider,
                usageAccountId: firstParam(params.usageAccountId),
                usageRuntimeKey: firstParam(params.usageRuntimeKey)
              }
            }
          : {})
      })
    : null
  if (route === null) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  return <MobileWebShellScreen key={shellScreenRouteKey(route)} hostId={hostId} route={route} />
}
