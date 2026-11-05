import { useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { AccountPoolSection } from '../../../src/renderer/src/components/settings/AccountPoolSection'
import { snapshot, subscribe } from './fake-host'
import './fixture.css'
function Fixture() {
  const [host, setHost] = useState('fixture-host-a')
  const calls = useSyncExternalStore(subscribe, snapshot)
  return (
    <main className="space-y-4 bg-background p-6 text-foreground">
      <button onClick={() => setHost('fixture-host-b')}>Switch fixture host</button>
      <AccountPoolSection target={{ kind: 'environment', environmentId: host }} hostLabel={host} />
      <output data-testid="requests" hidden>
        {calls}
      </output>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
