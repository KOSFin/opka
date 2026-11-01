import { captureTaskEditContext, taskEditContextMatches } from './project-task-edit-context'
import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { PickerModal } from '../components/PickerModal'
import { colors } from '../theme/mobile-theme'
import { createMobileTaskContent, updateMobileTaskContent } from './project-task-editing'
import { taskCreate, taskUpdate } from './project-task-mutations'
import { editorStyles as styles } from './project-task-editor-styles'

export function ProjectTaskEditor(props: {
  client: RpcClient | null
  connected: boolean
  worktree: string
  executionHostId: string
  sources?: { id: string; path: string }[]
  task?: { id: string; title: string; revision: string; body: string; content: string }
  onCancel: () => void
  onDone: () => void
}) {
  // Keep the revision the user began editing; a refreshed plan must not bypass its fence.
  const [editingTask] = useState(props.task)
  const [editingContext] = useState(() => captureTaskEditContext(props))
  const latest = useRef(props)
  latest.current = props
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const contextMatches = () =>
    mounted.current &&
    taskEditContextMatches(editingContext, latest.current) &&
    editingTask?.id === latest.current.task?.id
  const changedOwner = !contextMatches()
  const [id] = useState(() => `task-${randomV4Uuid()}`)
  const [title, setTitle] = useState(editingTask?.title ?? '')
  const [body, setBody] = useState(editingTask?.body ?? '')
  const [acceptance, setAcceptance] = useState('')
  const [source, setSource] = useState(props.sources?.[0]?.id ?? '')
  const [pickSource, setPickSource] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const disabled =
    changedOwner || busy || !props.connected || !props.client || !props.executionHostId
  async function save() {
    if (!contextMatches()) {
      setError('Project or host changed. Reopen this editor to save safely.')
      return
    }
    if (disabled || !editingContext.client) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const base = {
        worktree: editingContext.worktree,
        expectedExecutionHostId: editingContext.executionHostId
      }
      if (editingTask) {
        const content = updateMobileTaskContent(editingTask.content, title, body)
        taskUpdate.interpret(
          await taskUpdate.request(editingContext.client, {
            ...base,
            id: editingTask.id,
            revision: editingTask.revision,
            content
          })
        )
      } else {
        if (!source) {
          throw new Error('No task source available. Refresh the project before creating a card.')
        }
        const content = createMobileTaskContent(id, title, body, acceptance)
        taskCreate.interpret(
          await taskCreate.request(editingContext.client, { ...base, source, slug: id, content })
        )
      }
      if (contextMatches()) {
        latest.current.onDone()
      }
    } catch (failure) {
      if (contextMatches()) {
        setError(failure instanceof Error ? failure.message : 'Could not save task.')
      }
    } finally {
      if (contextMatches()) {
        setBusy(false)
      }
    }
  }
  return (
    <View style={styles.form}>
      <Text style={styles.title}>{editingTask ? 'Edit task' : 'New task'}</Text>
      <Text style={styles.label}>Title</Text>
      <TextInput
        accessibilityLabel="Task title"
        value={title}
        onChangeText={setTitle}
        editable={!busy}
        style={styles.input}
        placeholderTextColor={colors.textMuted}
      />
      <Text style={styles.label}>{editingTask ? 'Plan and task details' : 'Goal'}</Text>
      <TextInput
        accessibilityLabel={editingTask ? 'Task details' : 'Task goal'}
        value={body}
        onChangeText={setBody}
        multiline
        editable={!busy}
        style={[styles.input, styles.multiline]}
        placeholderTextColor={colors.textMuted}
      />
      {!editingTask ? (
        <>
          <Text style={styles.label}>Acceptance criteria · one per line</Text>
          <TextInput
            accessibilityLabel="Task acceptance criteria"
            value={acceptance}
            onChangeText={setAcceptance}
            multiline
            editable={!busy}
            style={[styles.input, styles.multiline]}
          />
          {(props.sources?.length ?? 0) > 1 ? (
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              onPress={() => setPickSource(true)}
              disabled={busy}
            >
              <Text style={styles.text}>Task source: {source}</Text>
            </Pressable>
          ) : null}
        </>
      ) : (
        <Text style={styles.label}>
          Changes require the updated plan to be approved before execution.
        </Text>
      )}
      {changedOwner ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Project or host changed. Reopen this editor to save safely.
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          disabled={disabled}
          onPress={() => void save()}
        >
          <Text style={styles.text}>{busy ? 'Saving…' : 'Save task'}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          disabled={busy && !changedOwner}
          onPress={props.onCancel}
        >
          <Text style={styles.text}>Cancel</Text>
        </Pressable>
      </View>
      <PickerModal
        visible={pickSource}
        title="Task source"
        selected={source}
        options={(props.sources ?? []).map((entry) => ({ value: entry.id, label: entry.id }))}
        onClose={() => setPickSource(false)}
        onSelect={(value) => {
          setSource(value)
          setPickSource(false)
        }}
      />
    </View>
  )
}
