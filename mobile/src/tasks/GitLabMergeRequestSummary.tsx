import { Pressable, Text, View } from 'react-native'
import type { GitLabWorkItem } from './mobile-tasks-provider-detail-types'
import { gitLabApprovalLabel, type GitLabApprovalState } from './gitlab-approval-label'
import { styles } from './mobile-tasks-legacy-styles'

export function GitLabMergeRequestSummary({
  item,
  approval,
  onCopySourceBranch,
  sourceBranchCopied
}: {
  item: GitLabWorkItem
  approval?: GitLabApprovalState
  onCopySourceBranch?: (branch: string) => void
  sourceBranchCopied?: boolean
}) {
  const approvalLabel = gitLabApprovalLabel(approval)
  const rows = [
    {
      label: 'Project',
      value: item.projectRef ? `${item.projectRef.host}/${item.projectRef.path}` : null
    },
    { label: 'Author', value: item.author },
    { label: 'Source branch', value: item.branchName },
    { label: 'Target branch', value: item.baseRefName },
    { label: 'Approvals', value: approvalLabel }
  ].filter((row) => row.value)
  return (
    <View style={styles.detailMetaGrid}>
      {rows.map((row) => (
        <View key={row.label} style={styles.detailMetaItem}>
          <Text style={styles.detailMetaLabel}>{row.label}</Text>
          <Text selectable style={styles.detailMetaValue}>
            {row.value}
          </Text>
          {row.label === 'Source branch' && item.branchName && onCopySourceBranch ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy source branch"
              onPress={() => onCopySourceBranch(item.branchName ?? '')}
              style={styles.inlineSaveButtonCompact}
            >
              <Text style={styles.inlineSaveText}>
                {sourceBranchCopied ? 'Copied' : 'Copy branch'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  )
}
