import { StyleSheet } from 'react-native'
import type { DelegationAction } from '../../../src/shared/project-task-delegation'
import { colors, spacing, typography } from '../theme/mobile-theme'

export const ACTION_LABELS: Record<DelegationAction, string> = {
  'approve-plan': 'Approve plans',
  'request-changes': 'Request changes',
  'send-to-integration': 'Send to integration',
  'accept-result': 'Accept reviewed results'
}

export const styles = StyleSheet.create({
  section: { gap: spacing.sm, padding: spacing.md, backgroundColor: colors.bgPanel },
  review: { gap: spacing.sm, padding: spacing.md, backgroundColor: colors.bgRaised },
  heading: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  label: { color: colors.textPrimary, fontSize: typography.bodySize },
  text: { color: colors.textPrimary, fontSize: typography.bodySize },
  meta: { color: colors.textMuted, fontSize: typography.metaSize },
  error: { color: colors.statusAmber, fontSize: typography.bodySize },
  input: {
    minHeight: 48,
    padding: spacing.md,
    color: colors.textPrimary,
    backgroundColor: colors.bgRaised
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  button: {
    minHeight: 48,
    justifyContent: 'center',
    padding: spacing.md,
    backgroundColor: colors.bgRaised
  }
})
