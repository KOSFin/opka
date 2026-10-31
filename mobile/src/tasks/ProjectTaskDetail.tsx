import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { colors } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc-client'
import { ProjectTaskSessionLink } from './ProjectTaskSessionLink'
import { ProjectTaskLaunch } from './ProjectTaskLaunch'
import { ProjectTaskDecision } from './ProjectTaskDecision'
import type { MobileProjectTask } from './project-task-rpc'
import {
  projectTaskScreenStyles as styles,
  projectTaskPhaseLabel
} from './project-task-screen-styles'

type Props = {
  client: RpcClient | null
  connected: boolean
  hostId: string
  worktree: string
  executionHostId: string
  task: MobileProjectTask
  body: string
  documents: string[]
  selectedDocument: string | null
  report: string
  onDocument: (path: string) => void
  onDone: () => void
}

export function ProjectTaskDetail(props: Props) {
  const { task } = props
  const [section, setSection] = useState<'overview' | 'reports' | 'activity'>('overview')
  return (
    <>
      {!props.selectedDocument ? (
        <MobileSegmentedControl
          fill
          segments={[
            { value: 'overview', label: 'Overview' },
            { value: 'reports', label: `Reports (${props.documents.length})` },
            { value: 'activity', label: 'Activity' }
          ]}
          selected={section}
          onSelect={setSection}
          style={styles.tabs}
        />
      ) : null}
      {props.selectedDocument ? (
        <>
          <Text style={styles.documentPath}>{props.selectedDocument}</Text>
          <MobileMarkdown content={props.report} fallback="Loading document…" />
        </>
      ) : section === 'overview' ? (
        <>
          <Text style={styles.meta}>
            {projectTaskPhaseLabel(task.workflow.phase)}
            {task.workflow.revisionChanged ? ' · Plan changed' : ''}
          </Text>
          <MobileMarkdown content={props.body} fallback="Loading task…" />
          <ProjectTaskLaunch {...props} />
          <View style={styles.section}>
            <Text style={styles.sectionHeading}>
              Agent sessions · {task.workflow.attempts.length}
            </Text>
            <View style={styles.group}>
              {task.workflow.attempts.length === 0 ? (
                <Text style={[styles.meta, styles.empty]}>No agent has started this task yet.</Text>
              ) : null}
              {task.workflow.attempts.map((attempt) => (
                <View style={styles.row} key={attempt.id}>
                  <Text style={styles.text}>{attempt.nativeStatus}</Text>
                  {attempt.session?.address || attempt.terminal ? (
                    <ProjectTaskSessionLink
                      client={props.client}
                      connected={props.connected}
                      hostId={props.hostId}
                      terminal={attempt.session?.address ?? attempt.terminal ?? ''}
                    />
                  ) : (
                    <Text style={styles.meta}>No agent session recorded</Text>
                  )}
                  {attempt.session?.blocker ? (
                    <Text style={styles.notice}>{attempt.session.blocker}</Text>
                  ) : null}
                </View>
              ))}
            </View>
          </View>
          <ProjectTaskDecision {...props} />
        </>
      ) : section === 'reports' ? (
        <View style={styles.section}>
          <Text style={styles.sectionHeading}>Reports and checkpoints</Text>
          <View style={styles.group}>
            {props.documents.length === 0 ? (
              <Text style={[styles.meta, styles.empty]}>
                No saved reports yet. Results appear here when the agent submits them.
              </Text>
            ) : null}
            {props.documents.map((path) => (
              <Pressable
                key={path}
                accessibilityRole="button"
                onPress={() => props.onDocument(path)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <View style={styles.rowLine}>
                  <View style={styles.rowMain}>
                    <Text style={styles.text}>{path.split('/').at(-1)}</Text>
                    <Text style={styles.documentPath} numberOfLines={2}>
                      {path}
                    </Text>
                  </View>
                  <ChevronRight size={16} color={colors.textMuted} />
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.section}>
          <Text style={styles.sectionHeading}>Activity · {task.workflow.events.length}</Text>
          <View style={styles.group}>
            {task.workflow.events.length === 0 ? (
              <Text style={[styles.meta, styles.empty]}>No activity yet.</Text>
            ) : null}
            {task.workflow.events.map((event) => (
              <View style={styles.row} key={event.sequence}>
                <Text style={styles.text}>{event.detail || event.kind}</Text>
                <Text style={styles.meta}>{event.createdAt}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </>
  )
}
