import { Circle, CircleCheck, CircleDot, ClipboardCheck, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { projectTaskNeedsDecision } from '../../../../shared/project-task-attention'
import { taskViewKey, type TaskViewRow } from './project-task-projects'
import { getWorkspaceStatusVisualMeta } from '../sidebar/workspace-status'

export const TASK_COLUMNS = [
  { id: 'planned', title: 'Planned', phases: ['draft', 'ready'], icon: Circle },
  { id: 'active', title: 'In progress', phases: ['active'], icon: CircleDot },
  { id: 'review', title: 'Review', phases: ['review', 'integration'], icon: ClipboardCheck },
  { id: 'done', title: 'Done', phases: ['done'], icon: CircleCheck }
] as const

export function ProjectTaskBoard({
  tasks,
  selected,
  onSelect,
  onCreate,
  onMove
}: {
  tasks: TaskViewRow[]
  selected: string
  onSelect: (key: string) => void
  onCreate?: () => void
  onMove: (task: TaskViewRow, phase: 'draft' | 'active' | 'review' | 'done') => void
}) {
  return (
    <div
      className="scrollbar-sleek flex min-h-0 flex-1 gap-4 overflow-x-auto p-5"
      aria-label="Task board"
    >
      {TASK_COLUMNS.map(({ id, title, phases, icon: Icon }) => {
        const meta = getWorkspaceStatusVisualMeta(
          id === 'planned'
            ? 'todo'
            : id === 'active'
              ? 'in-progress'
              : id === 'review'
                ? 'in-review'
                : 'completed'
        )
        const rows = tasks.filter((task) => phases.some((phase) => phase === task.workflow.phase))
        return (
          <section
            key={id}
            aria-label={title}
            className={cn(
              'flex min-h-0 min-w-56 flex-1 flex-col rounded-md border border-t-2 border-border p-3',
              meta.border,
              meta.laneTint
            )}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes('application/x-orca-project-task')) {
                event.preventDefault()
              }
            }}
            onDrop={(event) => {
              const task = tasks.find(
                (entry) =>
                  taskViewKey(entry) ===
                  event.dataTransfer.getData('application/x-orca-project-task')
              )
              if (
                task &&
                !task.workflow.attempts.length &&
                !phases.some((phase) => phase === task.workflow.phase)
              ) {
                event.preventDefault()
                onMove(task, id === 'planned' ? 'draft' : id)
              }
            }}
          >
            <h2 className="mb-3 flex items-center gap-2 px-1 text-sm font-medium">
              <Icon className={cn('size-4', meta.tone)} />
              {title}
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {rows.length}
              </span>
            </h2>
            <div className="scrollbar-sleek min-h-0 flex-1 space-y-2 overflow-y-auto pb-2">
              {rows.map((task) => (
                <button
                  key={taskViewKey(task)}
                  type="button"
                  draggable={!task.workflow.attempts.length && !task.workflow.archived}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-orca-project-task', taskViewKey(task))
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  data-testid="project-task-card"
                  data-current={selected === taskViewKey(task)}
                  className={cn(
                    'block w-full space-y-3 rounded-lg border bg-card p-3 text-left text-card-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    selected === taskViewKey(task) && 'bg-accent'
                  )}
                  onClick={() => onSelect(taskViewKey(task))}
                >
                  <span className="block break-words text-sm font-medium">{task.title}</span>
                  {task.projectLabel && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {task.projectLabel}
                    </span>
                  )}
                  <span className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {task.workflow.phase === 'draft'
                        ? 'Plan to refine'
                        : task.workflow.phase === 'ready'
                          ? 'Plan approved'
                          : task.workflow.phase === 'integration'
                            ? 'Integration'
                            : task.workflow.phase}
                    </span>
                    {task.workflow.revisionChanged && <span>Plan changed</span>}
                    {task.workflow.phase === 'active' &&
                      projectTaskNeedsDecision(task.workflow) && <span>Needs your decision</span>}
                    {task.workflow.archived && <span>Archived</span>}
                    {task.parent && <span>Subtask</span>}
                  </span>
                </button>
              ))}
              {!rows.length && (
                <p className="px-1 py-3 text-xs text-muted-foreground">
                  {id === 'planned'
                    ? 'New ideas and plans start here.'
                    : id === 'active'
                      ? 'Tasks being worked on.'
                      : id === 'review'
                        ? 'Results waiting for review.'
                        : 'Accepted results.'}
                </p>
              )}
              {id === 'planned' && onCreate && (
                <Button variant="ghost" size="sm" onClick={onCreate}>
                  <Plus /> Add task
                </Button>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
