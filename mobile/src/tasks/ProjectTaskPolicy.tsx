import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import {
  PROJECT_TASK_DELEGATION_CAPABILITY,
  TaskDelegationAction,
  type DelegationAction
} from '../../../src/shared/project-task-delegation'
import type { RpcClient } from '../transport/rpc-client'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { colors } from '../theme/mobile-theme'
import { ACTION_LABELS, styles } from './project-task-policy-presentation'
import {
  taskPolicyConfirm,
  taskPolicyPropose,
  taskPolicyRead,
  type TaskPolicy,
  type TaskPolicyProposal
} from './project-task-policy-operations'
export function ProjectTaskPolicy(props: {
  client: RpcClient | null
  connected: boolean
  supported: boolean
  hostId: string
  worktree: string
  executionHostId: string
  projectName: string
  onChanged: () => void
}) {
  const latest = useRef(props)
  latest.current = props
  const owner = `${props.hostId}:${props.worktree}:${props.executionHostId}`
  const generation = props.client?.getGeneration?.() ?? 0
  const busyRef = useRef(false)
  const [policy, setPolicy] = useState<TaskPolicy | null>(null)
  const [observedAt, setObservedAt] = useState(0)
  const [proposal, setProposal] = useState<TaskPolicyProposal | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [grantee, setGrantee] = useState('')
  const [runId, setRunId] = useState('')
  const [taskIds, setTaskIds] = useState('')
  const [hours, setHours] = useState(8)
  const [actions, setActions] = useState<DelegationAction[]>(['approve-plan'])
  const current = () =>
    latest.current.client === props.client &&
    latest.current.hostId === props.hostId &&
    latest.current.worktree === props.worktree &&
    latest.current.executionHostId === props.executionHostId &&
    (props.client?.getGeneration?.() ?? 0) === generation &&
    props.client?.getState() === 'connected'
  const target = {
    worktree: props.worktree,
    expectedExecutionHostId: props.executionHostId,
    capability: PROJECT_TASK_DELEGATION_CAPABILITY
  } as const

  async function read() {
    if (!props.client || !props.supported || !props.connected || !props.executionHostId) {
      return
    }
    const result = taskPolicyRead.interpret(await taskPolicyRead.request(props.client, target))
    if (current()) {
      setObservedAt(Date.now())
      setPolicy(result)
    }
  }

  useEffect(() => {
    if (!policy?.grant || policy.grant.expiresAt <= observedAt) {
      return
    }
    const timeout = setTimeout(() => setObservedAt(Date.now()), policy.grant.expiresAt - observedAt)
    return () => clearTimeout(timeout)
  }, [policy, observedAt])

  useEffect(() => {
    setPolicy(null)
    setProposal(null)
    setError('')
    busyRef.current = false
    setBusy(false)
    if (props.supported && props.connected && props.client && props.executionHostId) {
      void read().catch((cause: unknown) => {
        if (current()) {
          setError(cause instanceof Error ? cause.message : 'Policy unavailable')
        }
      })
    }
  }, [props.client, owner, props.supported, props.connected, generation])

  async function begin(manual: boolean) {
    if (!props.client || !props.connected || !props.supported || !policy || busyRef.current) {
      return
    }
    if (!manual && (!grantee.trim() || !actions.length)) {
      setError('Enter a verified grantee and choose an action.')
      return
    }
    const narrowed = taskIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    if (narrowed.length > 1000) {
      setError('Choose at most 1000 task IDs.')
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = taskPolicyPropose.interpret(
        await taskPolicyPropose.request(props.client, {
          ...target,
          expectedGeneration: policy.generation,
          grant: manual
            ? null
            : {
                grantee: grantee.trim(),
                actions,
                runId: runId.trim() || null,
                taskIds: narrowed.length ? narrowed : null,
                expiresAt: Date.now() + hours * 60 * 60 * 1000
              }
        })
      )
      if (current()) {
        setProposal(result)
      }
    } catch (cause) {
      if (current()) {
        setError(cause instanceof Error ? cause.message : 'Proposal failed. Refresh this host.')
        void read().catch(() => {
          if (current()) {
            setPolicy(null)
          }
        })
      }
    } finally {
      if (current()) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  async function confirm() {
    if (!props.client || !proposal || busyRef.current || !current()) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    const selected = proposal
    setProposal(null)
    try {
      taskPolicyConfirm.interpret(
        await taskPolicyConfirm.request(props.client, {
          ...target,
          proposal: selected.id,
          digest: selected.digest,
          requestId: randomV4Uuid()
        })
      )
      if (current()) {
        await read()
        latest.current.onChanged()
      }
    } catch (cause) {
      if (current()) {
        setError(
          cause instanceof Error
            ? `${cause.message} Refresh the host policy before another proposal.`
            : 'Confirmation uncertain. Refresh the host policy before another proposal.'
        )
        void read().catch(() => {
          if (current()) {
            setPolicy(null)
          }
        })
      }
    } finally {
      if (current()) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  if (!props.supported) {
    return <Text style={styles.meta}>Manual approval · this host does not support delegation.</Text>
  }
  return (
    <View style={styles.section} accessibilityLabel="Project task approval mode">
      <Text style={styles.heading}>Task approval</Text>
      <Text style={styles.meta}>
        {policy
          ? `${policy.grant && policy.grant.expiresAt > observedAt ? 'Delegated policy' : policy.grant ? 'Manual review required · grant expired' : 'Manual'} · generation ${policy.generation}`
          : 'Checking host policy…'}
      </Text>
      {policy?.grant ? (
        <Text style={styles.meta}>
          {policy.grant.actorAddress} · expires {new Date(policy.grant.expiresAt).toLocaleString()}
        </Text>
      ) : null}
      {policy && !proposal ? (
        <>
          <Text style={styles.label}>Verified grantee session or terminal</Text>
          <TextInput
            accessibilityLabel="Verified grantee"
            value={grantee}
            onChangeText={setGrantee}
            editable={!busy}
            placeholder="Orca session or terminal handle"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
          />
          <Text style={styles.label}>Run ID (optional)</Text>
          <TextInput
            accessibilityLabel="Run ID"
            value={runId}
            onChangeText={setRunId}
            editable={!busy}
            placeholder="Any in-scope Run"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
          />
          <Text style={styles.label}>Task IDs (optional, comma separated)</Text>
          <TextInput
            accessibilityLabel="Task IDs"
            value={taskIds}
            onChangeText={setTaskIds}
            editable={!busy}
            placeholder="All in-project tasks"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
          />
          <Text style={styles.label}>Grant duration</Text>
          <View style={styles.actions}>
            {[1, 8, 24].map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{ selected: hours === value, disabled: busy }}
                disabled={busy}
                onPress={() => setHours(value)}
                style={styles.button}
              >
                <Text style={styles.text}>
                  {value}h{hours === value ? ' ✓' : ''}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>Allowed actions</Text>
          {TaskDelegationAction.options.map((action) => (
            <Pressable
              key={action}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: actions.includes(action), disabled: busy }}
              disabled={busy}
              onPress={() =>
                setActions((current) =>
                  current.includes(action)
                    ? current.filter((item) => item !== action)
                    : [...current, action]
                )
              }
              style={styles.button}
            >
              <Text style={styles.text}>
                {actions.includes(action) ? '☑' : '□'} {ACTION_LABELS[action]}
              </Text>
            </Pressable>
          ))}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !props.connected}
              onPress={() => void begin(false)}
              style={styles.button}
            >
              <Text style={styles.text}>Review delegation…</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !policy.grant || !props.connected}
              onPress={() => void begin(true)}
              style={styles.button}
            >
              <Text style={styles.text}>Revoke / manual…</Text>
            </Pressable>
          </View>
        </>
      ) : null}
      {proposal ? (
        <View style={styles.review}>
          <Text style={styles.heading}>
            {proposal.grant ? 'Confirm scoped delegation' : 'Return to manual approval'}
          </Text>
          <Text style={styles.text}>
            Host: {props.hostId} · {props.executionHostId}
          </Text>
          <Text style={styles.text}>Project: {props.projectName}</Text>
          <Text style={styles.text}>
            Root: {proposal.grant?.binding.root ?? policy?.grant?.binding.root}
          </Text>
          <Text style={styles.text}>
            Source revision:{' '}
            {proposal.grant?.binding.configRevision ?? policy?.grant?.binding.configRevision}
          </Text>
          <Text style={styles.text}>Generation: {proposal.expectedGeneration + 1}</Text>
          {proposal.grant ? (
            <>
              <Text style={styles.text}>
                Grantee: {proposal.grant.actorAddress} · {proposal.grant.actor.key}
              </Text>
              <Text style={styles.text}>
                Actions: {proposal.grant.actions.map((action) => ACTION_LABELS[action]).join(', ')}
              </Text>
              <Text style={styles.text}>Run: {proposal.grant.runId ?? 'Any in-scope Run'}</Text>
              <Text style={styles.text}>
                Tasks: {proposal.grant.taskIds?.join(', ') ?? 'All in-project tasks'}
              </Text>
              <Text style={styles.text}>
                Expires: {new Date(proposal.grant.expiresAt).toLocaleString()}
              </Text>
            </>
          ) : (
            <Text style={styles.text}>
              New delegated admission and acceptance will stop; reserved owners may finish.
            </Text>
          )}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => setProposal(null)}
              style={styles.button}
            >
              <Text style={styles.text}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !props.connected}
              onPress={() => void confirm()}
              style={styles.button}
            >
              <Text style={styles.text}>{busy ? 'Confirming…' : 'Confirm on host'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy || !props.connected}
        onPress={() =>
          void read().catch((cause: unknown) => {
            if (current()) {
              setError(cause instanceof Error ? cause.message : 'Policy unavailable')
            }
          })
        }
        style={styles.button}
      >
        <Text style={styles.text}>Refresh policy</Text>
      </Pressable>
      <Text style={styles.meta}>
        An authenticated interactive owner must confirm on this host. A proposal does not approve a
        card or accept a result.
      </Text>
    </View>
  )
}
