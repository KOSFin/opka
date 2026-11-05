import { useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { View } from 'react-native'
import { MobileAccountPoolSection } from '../../../mobile/src/accounts/MobileAccountPoolSection'
import { mobileClient, snapshot, subscribe } from './fake-host'
import { colors } from '../../../mobile/src/theme/mobile-theme'
function Fixture() {
  const [host, setHost] = useState('fixture-host-a')
  const client = useMemo(() => mobileClient(host), [host])
  const calls = useSyncExternalStore(subscribe, snapshot)
  return (
    <View style={{ backgroundColor: colors.bgBase, padding: 16, minHeight: '100%' }}>
      <button onClick={() => setHost('fixture-host-b')}>Switch fixture host</button>
      <MobileAccountPoolSection client={client} connected hostName={host} />
      <output data-testid="requests" hidden>
        {calls}
      </output>
    </View>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
