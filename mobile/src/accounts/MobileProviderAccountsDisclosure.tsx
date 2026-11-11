import { useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import type { ProviderKey } from '../components/AccountUsage'
import { ClaudeIcon, OpenAIIcon } from '../components/AgentIcons'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-accounts-screen-styles'

export function MobileProviderAccountsDisclosure({
  provider,
  summary,
  children
}: {
  provider: ProviderKey
  summary?: string
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const title = provider === 'claude' ? 'Claude' : 'Codex'
  const Icon = provider === 'claude' ? ClaudeIcon : OpenAIIcon
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title} accounts`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.row}
      >
        <Icon size={20} />
        <View style={styles.rowMain}>
          <Text style={styles.rowTitle}>{title}</Text>
          {summary ? <Text style={styles.rowSubtitle}>{summary}</Text> : null}
        </View>
        {expanded ? (
          <ChevronDown size={18} color={colors.textSecondary} />
        ) : (
          <ChevronRight size={18} color={colors.textSecondary} />
        )}
      </Pressable>
      {expanded ? children : null}
    </View>
  )
}
