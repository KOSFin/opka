import { StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

export const poolStyles = StyleSheet.create({
  memberSettings: { gap: spacing.sm },
  content: { padding: spacing.md, gap: spacing.sm },
  account: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    paddingTop: spacing.md,
    gap: spacing.sm
  },
  action: { paddingVertical: spacing.sm, minHeight: 44, justifyContent: 'center' },
  actionText: { color: colors.accentBlue, fontSize: typography.bodySize },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  priority: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  input: {
    color: colors.textPrimary,
    backgroundColor: colors.bgRaised,
    fontSize: typography.bodySize,
    padding: spacing.sm,
    minWidth: 64
  }
})
