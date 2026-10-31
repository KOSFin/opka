import { Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import type { MobileProjectTask } from './project-task-rpc'
import {
  projectTaskScreenStyles as styles,
  projectTaskPhaseLabel
} from './project-task-screen-styles'

type Project = { selector: string; name: string; state: string; message?: string }

export function ProjectTaskCatalog({
  projects,
  loading,
  onSelect
}: {
  projects: Project[]
  loading: boolean
  onSelect: (selector: string) => void
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Projects · {projects.length}</Text>
      <View style={styles.group}>
        {!loading && projects.length === 0 ? (
          <Text style={[styles.meta, styles.empty]}>
            No project boards on this host yet. Create a project and its tasks from Opka on your
            computer.
          </Text>
        ) : null}
        {projects.map((item) => (
          <Pressable
            accessibilityRole="button"
            key={item.selector}
            disabled={item.state !== 'configured'}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => onSelect(item.selector)}
          >
            <View style={styles.rowLine}>
              <View style={styles.rowMain}>
                <Text style={styles.text}>{item.name}</Text>
                <Text style={styles.meta}>
                  {item.state === 'configured'
                    ? 'Tasks, reports and activity'
                    : (item.message ?? 'Task board not configured')}
                </Text>
              </View>
              <ChevronRight size={16} color={colors.textMuted} />
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

export function ProjectTaskBoard({
  tasks,
  loading,
  onSelect
}: {
  tasks: MobileProjectTask[]
  loading: boolean
  onSelect: (task: MobileProjectTask) => void
}) {
  const phases = [
    ...new Set(tasks.map((item) => (item.workflow.archived ? 'archived' : item.workflow.phase)))
  ]
  const phaseOrder = ['draft', 'ready', 'active', 'review', 'integration', 'done', 'archived']
  phases.sort((a, b) => phaseOrder.indexOf(a) - phaseOrder.indexOf(b))
  return (
    <>
      {!loading && tasks.length === 0 ? (
        <Text style={styles.meta}>
          No tasks in this project. Add a task from Opka on your computer to track its plan and
          result here.
        </Text>
      ) : null}
      {phases.map((phase) => {
        const items = tasks.filter(
          (item) => (item.workflow.archived ? 'archived' : item.workflow.phase) === phase
        )
        return (
          <View style={styles.section} key={phase}>
            <Text style={styles.sectionHeading}>
              {phase === 'archived' ? 'Archived' : projectTaskPhaseLabel(phase)} · {items.length}
            </Text>
            <View style={styles.group}>
              {items.map((item) => (
                <Pressable
                  accessibilityRole="button"
                  key={item.id}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={() => onSelect(item)}
                >
                  <View style={styles.rowLine}>
                    <View style={styles.rowMain}>
                      <Text style={styles.text}>{item.title}</Text>
                      {item.workflow.revisionChanged ? (
                        <Text style={styles.notice}>Plan changed</Text>
                      ) : null}
                      <Text style={styles.meta}>{item.workflow.attempts.length} attempts</Text>
                    </View>
                    <ChevronRight size={16} color={colors.textMuted} />
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        )
      })}
    </>
  )
}
