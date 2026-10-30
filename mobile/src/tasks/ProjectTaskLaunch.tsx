import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View, StyleSheet } from 'react-native'
import { z } from 'zod'
import { PickerModal } from '../components/PickerModal'
import { useOptionalHostProtocolGates } from '../components/host-protocol-gates-context'
import { useRouteHandoff } from '../navigation/route-handoff'
import {
  launchAgentInExistingWorkspace,
  supportsMobileExistingAgentLaunch
} from '../session/mobile-existing-agent-launch'
import { localAgentDetectionRead } from './mobile-workspace-source-operations'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc-client'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import { colors, spacing, typography } from '../theme/mobile-theme'
import type { MobileProjectTask } from './project-task-rpc'

const workspaceRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.workspaces',
    method: 'worktree.ps',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'workspaces',
      z.object({
        worktrees: z.array(
          z.object({
            worktreeId: z.string(),
            path: z.string(),
            displayName: z.string(),
            branch: z.string(),
            isArchived: z.boolean()
          })
        )
      })
    )
  })
)
const resumeRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.resume',
    method: 'projectTask.resume',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'resume',
      z.object({
        revision: z.string(),
        executionHostId: z.string(),
        text: z.string(),
        workflow: z.object({ phase: z.string(), archived: z.boolean() })
      })
    )
  })
)
export function ProjectTaskLaunch({
  client,
  connected,
  hostId,
  worktree,
  executionHostId,
  task
}: {
  client: RpcClient | null
  connected: boolean
  hostId: string
  worktree: string
  executionHostId: string
  task: MobileProjectTask
}) {
  const gates = useOptionalHostProtocolGates()
  const router = useRouteHandoff()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [picker, setPicker] = useState<'workspace' | 'agent' | null>(null)
  const [workspaces, setWorkspaces] = useState<
    { value: string; label: string; subtitle: string }[]
  >([])
  const [agents, setAgents] = useState<{ value: string; label: string }[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState('')
  const [agent, setAgent] = useState('')
  const [prepared, setPrepared] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const [openedWorkspace, setOpenedWorkspace] = useState('')
  if (
    task.workflow.archived ||
    task.workflow.phase === 'active' ||
    task.workflow.phase === 'done'
  ) {
    return null
  }
  async function prepare() {
    if (!client || !connected || busy) {
      return
    }
    setBusy(true)
    setError('')
    try {
      if (!supportsMobileExistingAgentLaunch(gates?.hostCapabilities)) {
        throw new Error('Update this host before starting a task from the phone.')
      }
      const [inventory, detection] = await Promise.all([
        workspaceRead.request(client, { limit: 500 }).then(workspaceRead.interpret),
        localAgentDetectionRead.request(client).then(localAgentDetectionRead.interpret)
      ])
      if (!mounted.current) {
        return
      }
      const root = worktree.startsWith('path:') ? worktree.slice(5) : null
      const candidates = inventory.worktrees.filter(
        (row) =>
          !row.isArchived &&
          (worktree === row.worktreeId ||
            worktree === `id:${row.worktreeId}` ||
            (root !== null && row.path === root))
      )
      setWorkspaces(
        candidates.map((row) => ({
          value: row.worktreeId,
          label: row.displayName,
          subtitle: `${row.branch || 'Folder workspace'} · ${row.path}`
        }))
      )
      setAgents(
        detection.accepted
          ? detection.value.filter(isTuiAgent).map((value) => ({ value, label: value }))
          : []
      )
      setPrepared(true)
      if (!candidates.length) {
        throw new Error(
          'Open a workspace for this project on the host first. No unrelated workspace will be selected.'
        )
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not prepare task launch.')
    } finally {
      setBusy(false)
    }
  }
  async function launch() {
    if (!client || !connected || busy || uncertain || !selectedWorkspace || !isTuiAgent(agent)) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const packet = resumeRead.interpret(
        await resumeRead.request(client, { worktree, id: task.id })
      )
      if (packet.revision !== task.revision || packet.executionHostId !== executionHostId) {
        throw new Error('The plan or execution host changed. Refresh before launching.')
      }
      if (!mounted.current) {
        return
      }
      if (packet.workflow.archived || ['active', 'done'].includes(packet.workflow.phase)) {
        throw new Error(
          'This task is already active, accepted, or archived. Refresh and open its existing chat.'
        )
      }
      setOpenedWorkspace(selectedWorkspace)
      const result = await launchAgentInExistingWorkspace({
        client,
        hostCapabilities: gates?.hostCapabilities,
        worktreeId: selectedWorkspace,
        agent,
        launchSource: 'project_task',
        prompt: {
          delivery: 'submit',
          text: `Work with this project task in this chat. Use the Opka CLI named by ORCA_CLI_COMMAND. Read the task resume; claim the approved task before implementation, save progress and submit the actual report with project-task complete for operator review. Do not accept your own result. Delegate within the approved scope using the existing orchestration tools when needed. If approval is missing, help plan instead.\n\n${packet.text}`
        }
      })
      if (!mounted.current) {
        return
      }
      if (result.kind === 'unknown') {
        setUncertain(true)
        throw new Error(result.message)
      }
      if (result.kind !== 'launched') {
        throw new Error(
          result.kind === 'unsupported' ? 'Update this host before launching.' : result.message
        )
      }
      if (result.promptDelivered === false) {
        setOpenedWorkspace(result.result.worktreeId)
        setUncertain(true)
        setError(
          'Agent opened, but task prompt was not delivered. Open the workspace and inspect it before retrying.'
        )
        return
      }
      router.push(
        `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(result.result.worktreeId)}`
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not launch task.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={styles.section}>
      {!prepared ? (
        <Pressable
          accessibilityRole="button"
          disabled={!connected || busy}
          style={styles.button}
          onPress={() => void prepare()}
        >
          <Text style={styles.text}>
            {busy
              ? 'Loading launch choices…'
              : task.workflow.phase === 'draft' || task.workflow.revisionChanged
                ? 'Discuss plan'
                : 'Work on task'}
          </Text>
        </Pressable>
      ) : (
        <>
          <Text style={styles.text}>
            Start a new chat in an existing workspace. The host keeps its configured account and
            permissions.
          </Text>
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={() => setPicker('workspace')}
          >
            <Text style={styles.text}>
              {workspaces.find((row) => row.value === selectedWorkspace)?.label ??
                'Choose workspace'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={() => setPicker('agent')}
          >
            <Text style={styles.text}>{agent || 'Choose installed agent'}</Text>
          </Pressable>
          {agents.length === 0 ? (
            <Text style={styles.error}>No installed agents reported by this host.</Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={!connected || busy || uncertain || !agent || !selectedWorkspace}
            style={styles.button}
            onPress={() => void launch()}
          >
            <Text style={styles.text}>{busy ? 'Starting…' : 'Start task chat'}</Text>
          </Pressable>
          {busy ? (
            <Text style={styles.text}>
              Waiting for the agent. Sign-in may be required; you can open the workspace now.
            </Text>
          ) : null}
          {openedWorkspace ? (
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              onPress={() =>
                router.push(
                  `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(openedWorkspace)}`
                )
              }
            >
              <Text style={styles.text}>Open workspace</Text>
            </Pressable>
          ) : null}
          <PickerModal
            visible={picker === 'workspace'}
            title="Workspace"
            options={workspaces}
            selected={selectedWorkspace}
            onSelect={setSelectedWorkspace}
            onClose={() => setPicker(null)}
          />
          <PickerModal
            visible={picker === 'agent'}
            title="Agent"
            options={agents}
            selected={agent}
            onSelect={setAgent}
            onClose={() => setPicker(null)}
          />
        </>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}
const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  button: {
    minHeight: 48,
    padding: spacing.md,
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  text: { color: colors.textPrimary, fontSize: typography.bodySize },
  error: { color: colors.statusAmber, fontSize: typography.bodySize }
})
