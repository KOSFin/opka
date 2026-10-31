import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { ChevronLeft, RefreshCw } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-accounts-screen-styles'

export function MobileAccountsHeader({
  hostName,
  refreshing,
  disabled,
  onBack,
  onRefresh
}: {
  hostName: string
  refreshing: boolean
  disabled: boolean
  onBack: () => void
  onRefresh: () => void
}) {
  return (
    <View style={styles.topRow}>
      <Pressable
        style={styles.backButton}
        onPress={() => onBack()}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={8}
      >
        <ChevronLeft size={22} color={colors.textPrimary} />
      </Pressable>
      <View style={styles.titleWrap}>
        <Text style={styles.heading}>Accounts</Text>
        {hostName ? (
          <Text style={styles.subheading} numberOfLines={1}>
            {hostName}
          </Text>
        ) : null}
      </View>
      <Pressable
        style={styles.iconButton}
        onPress={onRefresh}
        disabled={disabled || refreshing}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Refresh accounts"
      >
        {refreshing ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <RefreshCw size={18} color={colors.textSecondary} />
        )}
      </Pressable>
    </View>
  )
}
