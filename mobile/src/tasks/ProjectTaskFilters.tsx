import { useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { PickerModal } from '../components/PickerModal'
import { colors } from '../theme/mobile-theme'
import { editorStyles } from './project-task-editor-styles'
import {
  projectTaskPhaseLabel,
  projectTaskScreenStyles as styles
} from './project-task-screen-styles'
export function ProjectTaskFilters({
  query,
  phase,
  onQuery,
  onPhase
}: {
  query: string
  phase: string
  onQuery: (value: string) => void
  onPhase: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <View style={styles.section}>
      <TextInput
        accessibilityLabel="Search project tasks"
        placeholder="Search tasks…"
        placeholderTextColor={colors.textMuted}
        value={query}
        onChangeText={onQuery}
        style={editorStyles.input}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Filter task status"
        style={styles.rowLine}
        onPress={() => setOpen(true)}
      >
        <Text style={styles.text}>
          {phase === 'all' ? 'All statuses' : projectTaskPhaseLabel(phase)}
        </Text>
      </Pressable>
      <PickerModal
        visible={open}
        title="Task status"
        selected={phase}
        options={[
          'all',
          'draft',
          'ready',
          'active',
          'review',
          'integration',
          'done',
          'blocked'
        ].map((value) => ({
          value,
          label: value === 'all' ? 'All statuses' : projectTaskPhaseLabel(value)
        }))}
        onClose={() => setOpen(false)}
        onSelect={(value) => {
          onPhase(value)
          setOpen(false)
        }}
      />
    </View>
  )
}
