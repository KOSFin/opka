import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ProjectTaskEntry } from '../../../../shared/project-task-contract'
import type { ProjectTaskWorkflow } from '../../../../shared/project-task-workflow'
import { projectTaskCall, type ProjectTaskClient } from './project-task-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { ProjectTaskConfirm, type ProjectTaskConfirmation } from './ProjectTaskConfirm'

export function ProjectTaskAttempts({
  client,
  task,
  workflow,
  refresh
}: {
  client: ProjectTaskClient
  task: ProjectTaskEntry
  workflow: ProjectTaskWorkflow
  refresh: () => void
}) {
  const [from, setFrom] = useState('')
  const [placement, setPlacement] = useState('new-child')
  const [repo, setRepo] = useState('')
  const [agent, setAgent] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [inspection, setInspection] = useState('')
  const [confirmation, setConfirmation] = useState<ProjectTaskConfirmation | null>(null)
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Attempts on the owning host</h3>
      <p className="text-xs text-muted-foreground">
        A managed worker needs a coordinator terminal bound to an existing Run. No new coordinator
        or account is fabricated here. Provider defaults apply to blank model and effort.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label="Coordinator terminal handle"
          placeholder="Coordinator terminal handle"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <Input
          aria-label="Worker placement"
          value={placement}
          onChange={(event) => setPlacement(event.target.value)}
        />
        <Input
          aria-label="Repository ID"
          placeholder="Repository ID (new-child placement)"
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
        />
        <Input
          aria-label="Agent ID"
          placeholder="Agent ID or leave provider default"
          value={agent}
          onChange={(event) => setAgent(event.target.value)}
        />
        <Input
          aria-label="Model"
          placeholder="Model (optional)"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
        <Input
          aria-label="Reasoning effort"
          placeholder="Reasoning effort (optional)"
          value={effort}
          onChange={(event) => setEffort(event.target.value)}
        />
      </div>
      <Button
        variant="outline"
        disabled={
          !from ||
          !placement ||
          workflow.archived ||
          workflow.approvedRevision !== task.revision ||
          workflow.phase !== 'ready'
        }
        onClick={() =>
          setConfirmation({
            title: 'Start approved task',
            description: `Start one managed attempt for ${task.title}, revision ${task.revision}, on ${client.executionHostId}. Existing runtime permissions and worker limits still apply.`,
            run: async () => {
              const receipt = await projectTaskCall<{ result?: { state?: string } }>(
                client,
                'start',
                {
                  id: task.id,
                  revision: task.revision,
                  launch: {
                    from,
                    worktree: placement,
                    spec: 'approved-project-plan',
                    ...(repo ? { repo } : {}),
                    ...(agent ? { agent } : {}),
                    ...(model ? { model } : {}),
                    ...(effort ? { effort } : {})
                  }
                }
              )
              refresh()
              if (receipt.result?.state !== 'ready') {
                throw new Error(
                  'The runtime did not confirm a ready start. The attempt was retained; inspect it before any retry.'
                )
              }
            }
          })
        }
      >
        Start managed worker
      </Button>
      {workflow.attempts.map((attempt) => (
        <div key={attempt.id} className="space-y-2 rounded-md border p-3 text-sm">
          <p className="break-all">
            {attempt.nativeTaskId} · {attempt.nativeStatus}
          </p>
          <p className="text-xs text-muted-foreground">
            Durable state: {attempt.workerState ?? 'no managed receipt'}. Live status is
            unverifiable until inspected. Run: {attempt.runId}
          </p>
          {attempt.dispatchId && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  void callRuntimeRpc(client.target, 'orchestration.workerShow', {
                    dispatch: attempt.dispatchId
                  })
                    .then((result) => setInspection(JSON.stringify(result, null, 2)))
                    .catch((error: unknown) =>
                      setInspection(error instanceof Error ? error.message : String(error))
                    )
                }}
              >
                Inspect worker
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  setConfirmation({
                    title: 'Stop this exact worker',
                    description: `Dispatch ${attempt.dispatchId}. A lost connection is not proof that the process stopped.`,
                    run: async () => {
                      const receipt = await projectTaskCall<{ state?: string }>(client, 'stop', {
                        id: task.id,
                        dispatch: attempt.dispatchId
                      })
                      refresh()
                      if (receipt.state !== 'stopped') {
                        throw new Error(
                          'Process stop was not confirmed. Inspect the retained worker receipt; do not infer exit or retry automatically.'
                        )
                      }
                    }
                  })
                }
              >
                Stop worker
              </Button>
            </div>
          )}
        </div>
      ))}
      {inspection && (
        <Textarea
          variant="code"
          aria-label="Worker inspection"
          className="min-h-48"
          readOnly
          value={inspection}
        />
      )}
      <ProjectTaskConfirm action={confirmation} onClose={() => setConfirmation(null)} />
    </div>
  )
}
