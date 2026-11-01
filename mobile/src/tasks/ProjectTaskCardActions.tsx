import { captureTaskEditContext, taskEditContextMatches } from './project-task-edit-context'
import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import { PickerModal } from '../components/PickerModal'
import type { MobileProjectTask } from './project-task-rpc'
import { ProjectTaskEditor } from './ProjectTaskEditor'
import { taskMove } from './project-task-mutations'
import { editorStyles as styles } from './project-task-editor-styles'

export function ProjectTaskCardActions(props: {
  client: RpcClient | null
  connected: boolean
  worktree: string
  executionHostId: string
  task: MobileProjectTask
  body: string
  content: string
  onDone: () => void
}) {
  const [editing, setEditing] = useState(false)
  const latest = useRef(props)
  latest.current = props
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const renderOwner = captureTaskEditContext(props)
  type MoveTarget = ReturnType<typeof captureTaskEditContext> & { id: string; revision: string }
  type MoveState = {
    owner: typeof renderOwner
    taskId: string
    target: MoveTarget | null
    busy: boolean
    error: string
  }
  const [storedMove, setStoredMove] = useState<MoveState>(() => ({
    owner: renderOwner,
    taskId: props.task.id,
    target: null,
    busy: false,
    error: ''
  }))
  const belongs = (state: MoveState) =>
    taskEditContextMatches(state.owner, props) && state.taskId === props.task.id
  const currentState = belongs(storedMove)
  const moveTarget = currentState ? storedMove.target : null
  const busy = currentState && storedMove.busy
  const error = currentState ? storedMove.error : ''
  function updateMove(next: Partial<Pick<MoveState, 'target' | 'busy' | 'error'>>) {
    if (
      !mounted.current ||
      !taskEditContextMatches(renderOwner, latest.current) ||
      props.task.id !== latest.current.task.id
    ) {
      return
    }
    setStoredMove((previous) => ({
      ...(belongs(previous)
        ? previous
        : { owner: renderOwner, taskId: props.task.id, target: null, busy: false, error: '' }),
      ...next
    }))
  }
  const setMoveTarget = (target: MoveTarget | null) => updateMove({ target })
  const setBusy = (busy: boolean) => updateMove({ busy })
  const setError = (error: string) => updateMove({ error })
  const disabled = busy || !props.connected || !props.client || !props.executionHostId
  const active = props.task.workflow.phase === 'active'
  if (editing) {
    return (
      <ProjectTaskEditor
        {...props}
        task={{ ...props.task, body: props.body, content: props.content }}
        onCancel={() => setEditing(false)}
      />
    )
  }
  async function move(phase: string) {
    const target = moveTarget
    setMoveTarget(null)
    const current = () =>
      mounted.current &&
      target &&
      taskEditContextMatches(target, latest.current) &&
      target.id === latest.current.task.id
    if (target && !current()) {
      setError('Project or host changed. Reopen Move task to continue safely.')
      return
    }
    if (
      !target ||
      disabled ||
      !target.client ||
      (phase !== 'draft' && phase !== 'active' && phase !== 'review')
    ) {
      return
    }
    setBusy(true)
    setError('')
    try {
      taskMove.interpret(
        await taskMove.request(target.client, {
          worktree: target.worktree,
          id: target.id,
          revision: target.revision,
          expectedExecutionHostId: target.executionHostId,
          phase,
          reason: 'Moved from mobile task actions'
        })
      )
      if (current()) {
        latest.current.onDone()
      }
    } catch (failure) {
      if (current()) {
        setError(failure instanceof Error ? failure.message : 'Could not move task.')
      }
    } finally {
      if (current()) {
        setBusy(false)
      }
    }
  }
  return (
    <View style={styles.form}>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          disabled={disabled || !props.content || active}
          onPress={() => setEditing(true)}
        >
          <Text style={styles.text}>Edit task</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          disabled={disabled}
          onPress={() =>
            setMoveTarget({
              ...captureTaskEditContext(props),
              id: props.task.id,
              revision: props.task.revision
            })
          }
        >
          <Text style={styles.text}>{busy ? 'Saving…' : 'Move task'}</Text>
        </Pressable>
      </View>
      <Text style={styles.label}>
        Moving changes status only. Use Start agent to run work and Accept result to finish review.
      </Text>
      {active ? (
        <Text style={styles.label}>Finish or release active work before editing the plan.</Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <PickerModal
        visible={moveTarget !== null}
        title="Move task"
        selected={props.task.workflow.phase}
        options={[
          { value: 'draft', label: 'Draft' },
          { value: 'active', label: 'In progress' },
          { value: 'review', label: 'Review' }
        ]}
        onClose={() => setMoveTarget(null)}
        onSelect={(phase) => void move(phase)}
      />
    </View>
  )
}
