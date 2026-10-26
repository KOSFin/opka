import { Button } from '@/components/ui/button'
import type { TaskProjectScope, TaskProjectView } from './project-task-projects'

export function ProjectTaskHelp({
  views,
  projects,
  choose
}: {
  views: TaskProjectView[]
  projects: TaskProjectScope[]
  choose: (key: string) => void
}) {
  return (
    <details className="border-t px-5 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">How tasks work · file locations</summary>
      <div className="scrollbar-sleek max-h-48 space-y-2 overflow-auto py-3">
        <p>
          Write a task → refine its plan → work on it → review the result. Open a card for its plan,
          activity, and execution. Working copies are Git checkouts, not tasks.
        </p>
        <p>
          Plans are ordinary task.md files in the project. Notes and checkpoints stay alongside
          them. Copy resume context inside a task to continue in another chat or account.
        </p>
        <p>
          Returning shows the last snapshot while checking its owning host. An unavailable host does
          not mean an agent stopped. All projects is checked on opening or Refresh; a selected
          project also receives live updates.
        </p>
        {views.map((view) => (
          <p key={view.scope.key} className="break-all">
            {view.scope.name} · {view.scope.hostLabel}: {view.scope.root} —{' '}
            {view.board.project.sources.map((entry) => entry.path).join(', ')}
          </p>
        ))}
        {projects
          .filter((project) => project.state !== 'configured')
          .map((project) => (
            <Button key={project.key} variant="link" size="sm" onClick={() => choose(project.key)}>
              Set up {project.name} · {project.hostLabel}
            </Button>
          ))}
        {views.flatMap((view) =>
          view.board.diagnostics.map((item) => (
            <p key={`${view.scope.key}:${item.path}`}>
              {view.scope.name}: {item.path}: {item.message}
            </p>
          ))
        )}
      </div>
    </details>
  )
}
