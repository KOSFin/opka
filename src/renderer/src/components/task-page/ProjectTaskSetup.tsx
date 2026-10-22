import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { projectTaskError, type TaskProjectScope } from './project-task-projects'

export function ProjectTaskSetup({
  project,
  refresh
}: {
  project: TaskProjectScope
  refresh: () => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  return (
    <section className="space-y-3 p-5" aria-label="Project task setup">
      <h2 className="text-base font-semibold">
        {project.state === 'unavailable'
          ? 'Project folder needs attention'
          : 'Start planning this project'}
      </h2>
      <p className="text-sm">
        {project.name} · {project.hostLabel}
      </p>
      <p className="break-all font-mono text-xs text-muted-foreground">{project.root}</p>
      <p className="max-w-prose text-sm text-muted-foreground">
        {project.state === 'unavailable'
          ? projectTaskError(new Error(project.message))
          : 'Task files have not been set up. Create the project configuration and templates here, then add your first task. Existing code and Git branches will not be changed.'}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {project.state === 'unconfigured' && (
        <Button
          disabled={pending}
          onClick={() => {
            setPending(true)
            setError('')
            void callRuntimeRpc<{ executionHostId: string }>(project.target, 'projectTask.target', {
              worktree: project.selector
            })
              .then((host) =>
                callRuntimeRpc(project.target, 'projectTask.init', {
                  worktree: project.selector,
                  expectedExecutionHostId: host.executionHostId
                })
              )
              .then(refresh)
              .catch((cause: unknown) => setError(projectTaskError(cause)))
              .finally(() => setPending(false))
          }}
        >
          {pending ? 'Setting up…' : 'Set up task files'}
        </Button>
      )}
    </section>
  )
}
