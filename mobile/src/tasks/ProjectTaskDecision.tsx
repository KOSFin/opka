import { useState } from 'react'
import { Pressable, Text, TextInput, View, StyleSheet } from 'react-native'
import { z } from 'zod'
import type { RpcClient } from '../transport/rpc-client'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { colors, spacing, typography } from '../theme/mobile-theme'
import type { MobileProjectTask } from './project-task-rpc'

const decisionWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.decide',
    method: 'projectTask.decide',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('decision', z.unknown())
  })
)
const approveWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.approve',
    method: 'projectTask.approve',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('approval', z.unknown())
  })
)
export function ProjectTaskDecision({
  client,
  connected,
  worktree,
  executionHostId,
  task,
  onDone
}: {
  client: RpcClient | null
  connected: boolean
  worktree: string
  executionHostId: string
  task: MobileProjectTask
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const review = task.workflow.phase === 'review' || task.workflow.phase === 'integration'
  if (!review && task.workflow.phase !== 'draft') {
    return null
  }
  async function act(action: 'accept' | 'changes' | 'approve') {
    if (!client || !connected || busy || !executionHostId) {
      return
    }
    setBusy(true)
    setError('')
    const params = {
      worktree,
      id: task.id,
      revision: task.revision,
      expectedExecutionHostId: executionHostId
    }
    try {
      if (action === 'approve') {
        approveWrite.interpret(await approveWrite.request(client, params))
      } else {
        decisionWrite.interpret(
          await decisionWrite.request(client, { ...params, action, reason: reason.trim() })
        )
      }
      onDone()
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Decision failed. Refresh before retrying.'
      )
    } finally {
      setBusy(false)
    }
  }
  const disabled = !connected || busy || !executionHostId || (review && !reason.trim())
  return (
    <View style={styles.section}>
      <Text style={styles.text}>
        {review
          ? 'Review the report before accepting the result.'
          : 'Approve this exact plan revision.'}
      </Text>
      {review ? (
        <TextInput
          accessibilityLabel="Review reason"
          placeholder="Review notes or requested changes"
          placeholderTextColor={colors.textMuted}
          value={reason}
          onChangeText={setReason}
          multiline
          maxLength={2000}
          style={styles.input}
        />
      ) : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          style={styles.button}
          onPress={() => void act(review ? 'accept' : 'approve')}
        >
          <Text style={styles.text}>
            {busy ? 'Saving…' : review ? 'Accept result' : 'Approve plan'}
          </Text>
        </Pressable>
        {review ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            style={styles.button}
            onPress={() => void act('changes')}
          >
            <Text style={styles.text}>Request changes</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}
const styles = StyleSheet.create({
  section: { gap: spacing.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  text: { color: colors.textPrimary, fontSize: typography.bodySize },
  error: { color: colors.statusAmber },
  input: {
    minHeight: 80,
    padding: spacing.md,
    color: colors.textPrimary,
    backgroundColor: colors.bgPanel
  },
  button: {
    minHeight: 48,
    justifyContent: 'center',
    padding: spacing.md,
    backgroundColor: colors.bgRaised
  }
})
