import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { DetailPayload } from './mobile-tasks-provider-detail-types'
import { styles } from './mobile-tasks-legacy-styles'

export function GitLabMergeRequestMetadata({
  detail
}: {
  detail: Extract<DetailPayload, { provider: 'gitlab' }>
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <View style={styles.detailSection}>
      <Text style={styles.detailSectionTitle}>Review and changes</Text>
      <Text selectable style={styles.detailLine}>
        Assignees:{' '}
        {detail.assigneesAvailable === false
          ? 'Unavailable on this host'
          : detail.assignees.join(', ') || 'None'}
      </Text>
      <Text selectable style={styles.detailLine}>
        Reviewers:{' '}
        {detail.reviewers === undefined
          ? 'Unavailable on this host'
          : detail.reviewers
              .map((reviewer) =>
                reviewer.name ? `${reviewer.name} (@${reviewer.username})` : `@${reviewer.username}`
              )
              .join(', ') || 'None'}
      </Text>
      {detail.labels.length ? (
        <Text selectable style={styles.detailMuted}>
          Labels: {detail.labels.join(', ')}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Changed files"
        accessibilityState={{ expanded }}
        disabled={!detail.files?.length}
        style={styles.fileActionRow}
        onPress={() => setExpanded((current) => !current)}
      >
        <Text style={styles.detailLine}>Changed files</Text>
        <Text style={styles.detailSectionMeta}>
          {detail.files === undefined ? 'Unavailable on this host' : detail.files.length}
        </Text>
      </Pressable>
      {expanded
        ? detail.files?.map((file) => (
            <View key={`${file.oldPath ?? ''}:${file.path}`} style={styles.fileCard}>
              <Text selectable style={styles.detailLine}>
                {file.path}
              </Text>
              {file.oldPath && file.oldPath !== file.path ? (
                <Text selectable style={styles.detailMuted}>
                  From {file.oldPath}
                </Text>
              ) : null}
              <Text style={styles.detailMuted}>
                {[
                  file.status,
                  file.isBinary ? 'Binary file' : undefined,
                  file.additions === undefined ? undefined : `+${file.additions}`,
                  file.deletions === undefined ? undefined : `−${file.deletions}`
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          ))
        : null}
    </View>
  )
}
