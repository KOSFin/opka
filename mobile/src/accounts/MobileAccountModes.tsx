import { MobileSectionReveal } from '../components/MobileSectionReveal'
import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { styles } from './mobile-accounts-screen-styles'

type Mode = 'accounts' | 'pools'

export function MobileAccountModes({
  mode,
  onSelect,
  accounts,
  pools
}: {
  mode: Mode
  onSelect: (mode: Mode) => void
  accounts: ReactNode
  pools: ReactNode
}) {
  return (
    <>
      <MobileSegmentedControl
        fill
        selected={mode}
        onSelect={onSelect}
        segments={[
          { value: 'accounts', label: 'Accounts' },
          { value: 'pools', label: 'Pools & switching' }
        ]}
      />
      <Text style={styles.rowSubtitle}>
        Defaults apply to new manual chats on this host. Pools choose accounts separately; existing
        chats keep their assigned account.
      </Text>
      <View
        testID="account-management-panel"
        accessibilityElementsHidden={mode !== 'accounts'}
        importantForAccessibility={mode === 'accounts' ? 'auto' : 'no-hide-descendants'}
        style={mode === 'accounts' ? undefined : styles.hiddenSection}
      >
        <MobileSectionReveal sectionKey="accounts" active={mode === 'accounts'}>
          {accounts}
        </MobileSectionReveal>
      </View>
      <View
        testID="account-pools-panel"
        accessibilityElementsHidden={mode !== 'pools'}
        importantForAccessibility={mode === 'pools' ? 'auto' : 'no-hide-descendants'}
        style={mode === 'pools' ? undefined : styles.hiddenSection}
      >
        <MobileSectionReveal sectionKey="pools" active={mode === 'pools'}>
          {pools}
        </MobileSectionReveal>
      </View>
    </>
  )
}
