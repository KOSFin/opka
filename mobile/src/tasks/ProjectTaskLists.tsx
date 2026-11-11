import { Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { ProjectTaskPhaseIcon } from './ProjectTaskPhaseIcon'
import { colors } from '../theme/mobile-theme'
import type { MobileProjectTask } from './project-task-rpc'
import { projectTaskNextAction } from '../../../src/shared/project-task-attention'
import {
  projectTaskScreenStyles as styles,
  projectTaskPhaseLabel
} from './project-task-screen-styles'

type Project = {
  selector: string
  name: string
  state: string
  message?: string
  groupId?: string
  groupName?: string
  repositoryName?: string
}

export function ProjectTaskCatalog({
  projects,
  loading,
  onSelect,
  selected,
  onToggle,
  onToggleGroup
}: {
  projects: Project[]
  loading: boolean
  onSelect: (selector: string) => void
  selected?: string[]
  onToggle?: (selector: string) => void
  onToggleGroup?: (selectors: string[]) => void
}) {
  const sections = new Map<string, { name: string | null; projects: Project[] }>()
  for (const project of projects) {
    const grouped = Boolean(project.groupId && project.groupName)
    const key = grouped ? `group:${project.groupId}` : project.selector
    const section = sections.get(key) ?? {
      name: grouped ? (project.groupName ?? null) : null,
      projects: []
    }
    section.projects.push(project)
    sections.set(key, section)
  }
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Projects · {sections.size}</Text>
      <View style={styles.group}>
        {!loading && projects.length === 0 ? (
          <Text style={[styles.meta, styles.empty]}>
            No project boards on this host yet. Create a project and its tasks from Opka on your
            computer.
          </Text>
        ) : null}
        {[...sections.entries()].map(([key, section]) => {
          const configuredSelectors = section.projects
            .filter((item) => item.state === 'configured')
            .map((item) => item.selector)
          const includedCount = configuredSelectors.filter(
            (selector) => selected?.includes('*') || selected?.includes(selector)
          ).length
          const groupChecked =
            configuredSelectors.length > 0 && includedCount === configuredSelectors.length
          const groupPartial = includedCount > 0 && !groupChecked
          return (
            <View key={key}>
              {section.name ? (
                selected && onToggleGroup ? (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Include project ${section.name}`}
                    accessibilityState={{
                      checked: groupPartial ? 'mixed' : groupChecked,
                      disabled: configuredSelectors.length === 0
                    }}
                    disabled={configuredSelectors.length === 0}
                    onPress={() => onToggleGroup(configuredSelectors)}
                    style={[styles.row, styles.rowLine]}
                  >
                    <Text style={styles.text}>{groupChecked ? '☑' : groupPartial ? '▣' : '□'}</Text>
                    <Text style={[styles.sectionHeading, styles.rowMain]}>{section.name}</Text>
                  </Pressable>
                ) : (
                  <Text style={styles.sectionHeading}>{section.name}</Text>
                )
              ) : null}
              {section.projects.map((item) => (
                <View key={item.selector} style={styles.row}>
                  <View style={styles.rowLine}>
                    {selected && onToggle ? (
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityLabel={`Include ${section.name ? `${section.name} / ${item.repositoryName ?? item.name}` : item.name}`}
                        accessibilityState={{
                          checked: selected.includes('*') || selected.includes(item.selector),
                          disabled: item.state !== 'configured'
                        }}
                        disabled={item.state !== 'configured'}
                        onPress={() => onToggle(item.selector)}
                        style={styles.iconButton}
                      >
                        <Text style={styles.text}>
                          {selected.includes('*') || selected.includes(item.selector) ? '☑' : '□'}
                        </Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${section.name ? `${section.name} / ${item.repositoryName ?? item.name}` : item.name}`}
                      disabled={item.state !== 'configured'}
                      style={({ pressed }) => [styles.rowMain, pressed && styles.rowPressed]}
                      onPress={() => onSelect(item.selector)}
                    >
                      <Text style={styles.text}>
                        {section.name ? (item.repositoryName ?? item.name) : item.name}
                      </Text>
                      <Text style={styles.meta}>
                        {item.state === 'configured'
                          ? 'Tasks, reports and activity'
                          : (item.message ?? 'Task board not configured')}
                      </Text>
                    </Pressable>
                    <ChevronRight size={16} color={colors.textMuted} />
                  </View>
                </View>
              ))}
            </View>
          )
        })}
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
          No tasks in this project. Add a task to describe its goal and acceptance criteria.
        </Text>
      ) : null}
      {phases.map((phase) => {
        const items = tasks.filter(
          (item) => (item.workflow.archived ? 'archived' : item.workflow.phase) === phase
        )
        return (
          <View style={styles.section} key={phase}>
            <View style={styles.rowLine}>
              <ProjectTaskPhaseIcon phase={phase} />
              <Text style={styles.sectionHeading}>
                {phase === 'archived' ? 'Archived' : projectTaskPhaseLabel(phase)} · {items.length}
              </Text>
            </View>
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
                      {item.workflow.attempts[0]?.session?.blocker ? (
                        <Text style={styles.notice}>
                          Waiting: {item.workflow.attempts[0].session.blocker}
                        </Text>
                      ) : null}
                      {projectTaskNextAction(item.workflow) ? (
                        <Text style={styles.meta}>
                          Next: {projectTaskNextAction(item.workflow)}
                        </Text>
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
