import { Text, View } from 'react-native'
import type { GitLabWorkItem } from './mobile-tasks-provider-detail-types'
import { gitLabApprovalLabel, type GitLabApprovalState } from './gitlab-approval-label'
import { styles } from './mobile-tasks-legacy-styles'

export function GitLabMergeRequestSummary({
  item,
  approval
}: {
  item: GitLabWorkItem
  approval?: GitLabApprovalState
}) {
  const approvalLabel = gitLabApprovalLabel(approval)
  const rows = [
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
        </View>
      ))}
    </View>
  )
}
