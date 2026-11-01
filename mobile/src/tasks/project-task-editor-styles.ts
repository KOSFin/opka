import { StyleSheet } from 'react-native'
import { colors, spacing, typography, radii } from '../theme/mobile-theme'

export const editorStyles = StyleSheet.create({
  form: {
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card
  },
  title: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  label: { color: colors.textSecondary, fontSize: typography.metaSize },
  input: {
    color: colors.textPrimary,
    backgroundColor: colors.bgRaised,
    padding: spacing.md,
    borderRadius: radii.input,
    fontSize: typography.bodySize,
    minHeight: 48
  },
  multiline: { minHeight: 112, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  button: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.sm },
  text: { color: colors.accentBlue, fontSize: typography.bodySize },
  error: { color: colors.statusRed, fontSize: typography.metaSize }
})
