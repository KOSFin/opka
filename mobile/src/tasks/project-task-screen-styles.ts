import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const projectTaskScreenStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  headerMain: { flex: 1, minWidth: 0, gap: spacing.xs },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xl * 2 },
  title: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '600' },
  sectionHeading: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600',
    paddingHorizontal: spacing.xs
  },
  text: { color: colors.textPrimary, fontSize: typography.bodySize },
  meta: { color: colors.textSecondary, fontSize: typography.metaSize, lineHeight: 18 },
  notice: { color: colors.statusAmber, fontSize: typography.bodySize, lineHeight: 20 },
  section: { gap: spacing.sm },
  group: { backgroundColor: colors.bgPanel, borderRadius: radii.card, overflow: 'hidden' },
  row: {
    minHeight: 60,
    padding: spacing.md,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowMain: { flex: 1, minWidth: 0 },
  rowPressed: { backgroundColor: colors.bgRaised },
  disabled: { opacity: 0.5 },
  empty: { padding: spacing.lg, gap: spacing.sm },
  tabs: { padding: spacing.md, backgroundColor: colors.bgPanel },
  documentPath: { color: colors.textMuted, fontSize: typography.metaSize, lineHeight: 18 }
})

export function projectTaskPhaseLabel(phase: string): string {
  switch (phase) {
    case 'draft':
      return 'Drafts'
    case 'ready':
      return 'Planned'
    case 'active':
    case 'running':
    case 'in_progress':
      return 'In progress'
    case 'blocked':
      return 'Needs attention'
    case 'review':
      return 'Review'
    case 'integration':
      return 'Integration'
    case 'done':
      return 'Done'
    default:
      return phase.replaceAll('_', ' ')
  }
}
