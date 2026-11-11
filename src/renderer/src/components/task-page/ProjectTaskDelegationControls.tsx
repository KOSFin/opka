import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  PROJECT_TASK_DELEGATION_CAPABILITY,
  TaskDelegationAction,
  type DelegationAction,
  type DelegationGrant
} from '../../../../shared/project-task-delegation'
import { projectTaskCall, type ProjectTaskClient } from './project-task-client'
import type { TaskProjectScope } from './project-task-projects'

type Policy = { generation: number; grant: DelegationGrant | null }
type Proposal = {
  id: string
  digest: string
  grant: DelegationGrant | null
  expectedGeneration: number
}
const ACTION_LABELS: Record<DelegationAction, string> = {
  'approve-plan': 'Approve plans',
  'request-changes': 'Request changes',
  'send-to-integration': 'Send to integration',
  'accept-result': 'Accept reviewed results'
}
const ACTIONS = TaskDelegationAction.options

function policyError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/method_not_found|unknown method|unsupported|not supported/i.test(message)) {
    return 'This host does not support delegated task decisions. Manual review remains available.'
  }
  if (/generation|changed|stale|conflict|expired|connection/i.test(message)) {
    return 'The policy or host changed. Refresh its current state and review a new proposal.'
  }
  return message
}

export function ProjectTaskDelegationControls({
  client,
  project
}: {
  client: ProjectTaskClient | null
  project: TaskProjectScope | undefined
}) {
  const active = useRef(client)
  const busyRef = useRef(false)
  const readGeneration = useRef(0)
  const readPending = useRef<Promise<void> | null>(null)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [observedAt, setObservedAt] = useState(0)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [grantee, setGrantee] = useState('')
  const [runId, setRunId] = useState('')
  const [taskIds, setTaskIds] = useState('')
  const [hours, setHours] = useState('8')
  const [actions, setActions] = useState<DelegationAction[]>(['approve-plan'])

  function read(current: ProjectTaskClient, keepError = false): Promise<void> {
    if (readPending.current) {
      return readPending.current
    }
    const generation = ++readGeneration.current
    setPolicy(null)
    setProposal(null)
    setSupported(null)
    setReading(true)
    if (!keepError) {
      setError('')
    }
    const pending = (async () => {
      try {
        const status = await callRuntimeRpc<{ capabilities?: string[] }>(
          current.target,
          'status.get'
        )
        if (active.current !== current || readGeneration.current !== generation) {
          return
        }
        if (!status.capabilities?.includes(PROJECT_TASK_DELEGATION_CAPABILITY)) {
          setSupported(false)
          setError('')
          return
        }
        const next = await projectTaskCall<Policy>(current, 'policy.read', {
          capability: PROJECT_TASK_DELEGATION_CAPABILITY
        })
        if (active.current === current && readGeneration.current === generation) {
          setObservedAt(Date.now())
          setPolicy(next)
          setSupported(true)
        }
      } catch {
        if (active.current === current && readGeneration.current === generation) {
          setError('The host policy could not be read. Refresh its current state and try again.')
        }
      } finally {
        if (active.current === current && readGeneration.current === generation) {
          readPending.current = null
          setReading(false)
        }
      }
    })()
    readPending.current = pending
    return pending
  }

  useEffect(() => {
    if (!policy?.grant || policy.grant.expiresAt <= observedAt) {
      return
    }
    const timeout = setTimeout(() => setObservedAt(Date.now()), policy.grant.expiresAt - observedAt)
    return () => clearTimeout(timeout)
  }, [policy, observedAt])

  useEffect(() => {
    active.current = client
    readPending.current = null
    setPolicy(null)
    setProposal(null)
    setSupported(null)
    setError('')
    busyRef.current = false
    setBusy(false)
    if (client) {
      void read(client)
    }
    return () => {
      if (active.current === client) {
        active.current = null
        readGeneration.current += 1
        readPending.current = null
      }
    }
  }, [client])

  async function begin(kind: 'delegate' | 'manual') {
    if (!client || !policy || !supported || busyRef.current || readPending.current) {
      return
    }
    if (kind === 'delegate' && (!grantee.trim() || actions.length === 0)) {
      setError('Choose a verified grantee and at least one action.')
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
      const next = await projectTaskCall<Proposal>(client, 'policy.propose', {
        capability: PROJECT_TASK_DELEGATION_CAPABILITY,
        expectedGeneration: policy.generation,
        grant:
          kind === 'manual'
            ? null
            : {
                grantee: grantee.trim(),
                actions,
                runId: runId.trim() || null,
                taskIds: narrowed.length ? narrowed : null,
                expiresAt: Date.now() + Number(hours) * 60 * 60 * 1000
              }
      })
      if (active.current === client) {
        setProposal(next)
      }
    } catch (cause) {
      if (active.current === client) {
        setError(policyError(cause))
        void read(client, true)
      }
    } finally {
      if (active.current === client) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  async function confirm() {
    if (!client || !proposal || !policy || !supported || busyRef.current || readPending.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    const current = proposal
    setProposal(null)
    try {
      await projectTaskCall(client, 'policy.confirm', {
        capability: PROJECT_TASK_DELEGATION_CAPABILITY,
        proposal: current.id,
        digest: current.digest,
        requestId: createBrowserUuid()
      })
      if (active.current === client) {
        await read(client)
      }
    } catch (cause) {
      if (active.current === client) {
        setError(policyError(cause))
        void read(client, true)
      }
    } finally {
      if (active.current === client) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  const grant = policy?.grant
  const expired = grant !== null && grant !== undefined && grant.expiresAt <= observedAt
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Project task approval mode">
      <div>
        <h3 className="text-sm font-medium">Task approval</h3>
        <p className="text-xs text-muted-foreground">
          Scoped to this project and execution host. Each task still needs its own review.
        </p>
      </div>
      <p aria-live="polite" className="text-sm">
        {!client || supported === false
          ? 'Manual · delegated controls unavailable on this host'
          : reading
            ? 'Checking host policy…'
            : !policy
              ? 'Manual · host policy unavailable'
              : grant && !expired
                ? `Delegated policy · generation ${policy.generation}`
                : grant
                  ? `Manual review required · grant expired at generation ${policy.generation}`
                  : `Manual · generation ${policy.generation}`}
      </p>
      {grant ? (
        <p className="break-words text-xs text-muted-foreground">
          {grant.actorAddress} · {grant.actions.map((action) => ACTION_LABELS[action]).join(', ')} ·
          expires {new Date(grant.expiresAt).toLocaleString()}
        </p>
      ) : null}
      {supported && policy ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="task-policy-grantee">Verified grantee session or terminal</Label>
            <Input
              id="task-policy-grantee"
              value={grantee}
              onChange={(event) => setGrantee(event.target.value)}
              placeholder="Orca session or terminal handle"
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-policy-run">Run ID (optional)</Label>
            <Input
              id="task-policy-run"
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
              placeholder="Any in-scope Run"
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-policy-tasks">Task IDs (optional, comma separated)</Label>
            <Input
              id="task-policy-tasks"
              value={taskIds}
              onChange={(event) => setTaskIds(event.target.value)}
              placeholder="All in-project tasks"
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-policy-expiry">Grant duration</Label>
            <Select value={hours} onValueChange={setHours} disabled={busy}>
              <SelectTrigger id="task-policy-expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 hour</SelectItem>
                <SelectItem value="8">8 hours</SelectItem>
                <SelectItem value="24">24 hours</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Allowed actions</legend>
            {ACTIONS.map((action) => (
              <label key={action} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={actions.includes(action)}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setActions((current) =>
                      checked === true
                        ? [...new Set([...current, action])]
                        : current.filter((item) => item !== action)
                    )
                  }
                />
                {ACTION_LABELS[action]}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void begin('delegate')}>
              Review delegation…
            </Button>
            <Button
              variant="outline"
              disabled={busy || !grant}
              onClick={() => void begin('manual')}
            >
              Revoke / return manual…
            </Button>
          </div>
        </>
      ) : null}
      {client && supported !== false ? (
        <Button variant="ghost" disabled={busy || reading} onClick={() => void read(client)}>
          Refresh policy
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Dialog open={proposal !== null} onOpenChange={(open) => !open && !busy && setProposal(null)}>
        <DialogContent surface="security" scrollable>
          <DialogHeader>
            <DialogTitle>
              {proposal?.grant ? 'Confirm scoped delegation' : 'Return to manual approval'}
            </DialogTitle>
            <DialogDescription>
              Only this authenticated interactive connection can confirm this host proposal. A
              reserved worker may still finish after revocation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 break-all text-sm">
            <p>Host: {project?.hostLabel ?? client?.executionHostId}</p>
            <p>Project: {project?.name ?? 'Selected project'}</p>
            <p>Root: {proposal?.grant?.binding.root ?? grant?.binding.root}</p>
            <p>
              Source revision:{' '}
              {proposal?.grant?.binding.configRevision ?? grant?.binding.configRevision}
            </p>
            <p>Generation: {proposal ? proposal.expectedGeneration + 1 : ''}</p>
            {proposal?.grant ? (
              <>
                <p>
                  Grantee: {proposal.grant.actorAddress} · verified identity{' '}
                  {proposal.grant.actor.key}
                </p>
                <p>
                  Actions:{' '}
                  {proposal.grant.actions.map((action) => ACTION_LABELS[action]).join(', ')}
                </p>
                <p>Run: {proposal.grant.runId ?? 'Any in-scope Run'}</p>
                <p>Tasks: {proposal.grant.taskIds?.join(', ') ?? 'All in-project tasks'}</p>
                <p>Expires: {new Date(proposal.grant.expiresAt).toLocaleString()}</p>
              </>
            ) : (
              <p>New delegated admissions and acceptance will stop.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setProposal(null)}>
              Cancel
            </Button>
            <Button disabled={busy || !proposal} onClick={() => void confirm()}>
              {busy ? 'Confirming…' : 'Confirm on this host'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
