import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { PROJECT_TASK_PROJECT_AGENTS_CAPABILITY } from '../../../src/shared/project-task-delegation'
import type { RpcClient } from '../transport/rpc-client'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { styles } from './project-task-policy-presentation'
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
  const readSequence = useRef(0)
  const renderedReadSequence = readSequence.current
  const [policy, setPolicy] = useState<TaskPolicy | null>(null)
  const [observedAt, setObservedAt] = useState(0)
  const [proposal, setProposal] = useState<TaskPolicyProposal | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sameOwner = () =>
    latest.current.client === props.client &&
    latest.current.hostId === props.hostId &&
    latest.current.worktree === props.worktree &&
    latest.current.executionHostId === props.executionHostId &&
    (props.client?.getGeneration?.() ?? 0) === generation
  const current = () => sameOwner() && props.client?.getState() === 'connected'
  const actionCurrent = () => current() && readSequence.current === renderedReadSequence
  const target = {
    worktree: props.worktree,
    expectedExecutionHostId: props.executionHostId,
    capability: PROJECT_TASK_PROJECT_AGENTS_CAPABILITY
  } as const

  async function read() {
    if (
      !props.client ||
      !props.supported ||
      !props.connected ||
      !props.executionHostId ||
      !sameOwner()
    ) {
      return
    }
    const request = ++readSequence.current
    setPolicy(null)
    setProposal(null)
    setError('')
    if (!current()) {
      setError('Host policy unavailable')
      return
    }
    try {
      const result = taskPolicyRead.interpret(await taskPolicyRead.request(props.client, target))
      if (current() && request === readSequence.current) {
        setObservedAt(Date.now())
        setPolicy(result)
      }
    } catch (cause) {
      if (sameOwner() && request === readSequence.current) {
        setError(cause instanceof Error ? cause.message : 'Policy unavailable')
      }
    }
  }

  async function refreshAfterAction() {
    busyRef.current = false
    setBusy(false)
    await read()
  }

  useEffect(() => {
    if (!policy?.grant || policy.grant.expiresAt === null || policy.grant.expiresAt <= observedAt) {
      return
    }
    const timeout = setTimeout(
      () => setObservedAt(Date.now()),
      Math.min(2_147_483_647, policy.grant.expiresAt - observedAt)
    )
    return () => clearTimeout(timeout)
  }, [policy, observedAt])

  useEffect(() => {
    readSequence.current += 1
    setPolicy(null)
    setProposal(null)
    setError('')
    busyRef.current = false
    setBusy(false)
    if (props.supported && props.connected && props.client && props.executionHostId) {
      void read()
    }
  }, [props.client, owner, props.supported, props.connected, generation])

  async function begin(manual: boolean) {
    if (
      !props.client ||
      !props.connected ||
      !props.supported ||
      !policy ||
      busyRef.current ||
      !actionCurrent()
    ) {
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
          grant: manual ? null : { mode: 'project-agents' }
        })
      )
      if (actionCurrent()) {
        setProposal(result)
      }
    } catch (cause) {
      if (actionCurrent()) {
        setError(cause instanceof Error ? cause.message : 'Proposal failed. Refresh this host.')
        void refreshAfterAction()
      }
    } finally {
      if (actionCurrent()) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  async function confirm() {
    if (!props.client || !proposal || busyRef.current || !actionCurrent()) {
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
      if (actionCurrent()) {
        await refreshAfterAction()
        if (current()) {
          latest.current.onChanged()
        }
      }
    } catch (cause) {
      if (actionCurrent()) {
        setError(
          cause instanceof Error
            ? `${cause.message} Refresh the host policy before another proposal.`
            : 'Confirmation uncertain. Refresh the host policy before another proposal.'
        )
        void refreshAfterAction()
      }
    } finally {
      if (actionCurrent()) {
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
          ? `${policy.grant && (policy.grant.expiresAt === null || policy.grant.expiresAt > observedAt) ? (policy.grant.schema === 2 ? 'Agents allowed' : 'Delegated policy') : policy.grant ? 'Manual review required · grant expired' : 'Manual'} · generation ${policy.generation}`
          : error
            ? 'Host policy unavailable · refresh to retry'
            : 'Checking host policy…'}
      </Text>
      {policy?.grant ? (
        <Text style={styles.meta}>
          {policy.grant.schema === 2 ? 'Verified project agents' : policy.grant.actorAddress} ·{' '}
          {policy.grant.expiresAt === null
            ? 'until revoked'
            : `expires ${new Date(policy.grant.expiresAt).toLocaleString()}`}
        </Text>
      ) : null}
      {policy && !proposal ? (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !props.connected}
            onPress={() => void begin(false)}
            style={styles.button}
          >
            <Text style={styles.text}>Allow agents…</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !policy.grant || !props.connected}
            onPress={() => void begin(true)}
            style={styles.button}
          >
            <Text style={styles.text}>Manual approval…</Text>
          </Pressable>
        </View>
      ) : null}
      {proposal ? (
        <View style={styles.review}>
          <Text style={styles.heading}>
            {proposal.grant ? 'Allow project agents' : 'Return to manual approval'}
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
                Agents: verified sessions and terminals on this project
              </Text>
              <Text style={styles.text}>
                Actions: task plan, changes, integration, and result decisions
              </Text>
              <Text style={styles.text}>
                Duration:{' '}
                {proposal.grant.expiresAt === null
                  ? 'Until revoked'
                  : new Date(proposal.grant.expiresAt).toLocaleString()}
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
        onPress={() => void read()}
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
