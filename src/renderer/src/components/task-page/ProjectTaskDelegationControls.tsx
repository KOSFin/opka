import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  PROJECT_TASK_PROJECT_AGENTS_CAPABILITY,
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
        if (!status.capabilities?.includes(PROJECT_TASK_PROJECT_AGENTS_CAPABILITY)) {
          setSupported(false)
          setError('')
          return
        }
        const next = await projectTaskCall<Policy>(current, 'policy.read', {
          capability: PROJECT_TASK_PROJECT_AGENTS_CAPABILITY
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
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const next = await projectTaskCall<Proposal>(client, 'policy.propose', {
        capability: PROJECT_TASK_PROJECT_AGENTS_CAPABILITY,
        expectedGeneration: policy.generation,
        grant: kind === 'manual' ? null : { mode: 'project-agents' }
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
        capability: PROJECT_TASK_PROJECT_AGENTS_CAPABILITY,
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
  const expired =
    grant !== null &&
    grant !== undefined &&
    grant.expiresAt !== null &&
    grant.expiresAt <= observedAt
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Project task approval mode">
      <div>
        <h3 className="text-sm font-medium">Task approval</h3>
        <p className="text-xs text-muted-foreground">
          Choose whether verified agents on this project can make task decisions. You can return to
          manual approval at any time.
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
                ? `${grant.schema === 2 ? 'Agents allowed' : 'Delegated policy'} · generation ${policy.generation}`
                : grant
                  ? `Manual review required · grant expired at generation ${policy.generation}`
                  : `Manual · generation ${policy.generation}`}
      </p>
      {grant ? (
        <p className="break-words text-xs text-muted-foreground">
          {grant.schema === 2 ? 'Verified project agents' : grant.actorAddress} ·{' '}
          {grant.expiresAt === null
            ? 'until revoked'
            : `expires ${new Date(grant.expiresAt).toLocaleString()}`}
        </p>
      ) : null}
      {supported && policy ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void begin('delegate')}>
            Allow agents…
          </Button>
          <Button variant="outline" disabled={busy || !grant} onClick={() => void begin('manual')}>
            Manual approval…
          </Button>
        </div>
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
              {proposal?.grant ? 'Allow project agents' : 'Return to manual approval'}
            </DialogTitle>
            <DialogDescription>
              Confirm this project policy on the owning host. A reserved worker may still finish
              after revocation.
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
                <p>Agents: verified agent sessions and terminals on this project</p>
                <p>Actions: task plan, changes, integration, and result decisions</p>
                <p>
                  Duration:{' '}
                  {proposal.grant.expiresAt === null
                    ? 'Until revoked'
                    : new Date(proposal.grant.expiresAt).toLocaleString()}
                </p>
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
