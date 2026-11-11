import { taskViewKey, type TaskViewRow } from './project-task-projects'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useEffect, useRef, useState } from 'react'
import { readProjectTaskView, saveProjectTaskView } from './project-task-view-state'
import { projectTaskNextAction } from '../../../../shared/project-task-attention'

function TaskRow({
  task,
  selected,
  onSelect
}: {
  task: TaskViewRow
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <Button
      variant={selected ? 'secondary' : 'ghost'}
      className="h-auto w-full justify-start whitespace-normal text-left"
      onClick={() => onSelect(taskViewKey(task))}
    >
      <span className="min-w-0">
        <span className="block truncate">{task.title}</span>
        {task.projectLabel && (
          <span className="block text-xs text-muted-foreground">{task.projectLabel}</span>
        )}
        <span className="block text-xs text-muted-foreground">
          {task.workflow.phase} · {task.repos.join(', ')}
          {task.workflow.revisionChanged ? ' · plan changed' : ''}
          {task.workflow.archived ? ' · archived' : ''}
        </span>
        {task.workflow.attempts[0]?.session?.blocker && (
          <span className="block text-xs text-muted-foreground">
            Waiting: {task.workflow.attempts[0].session.blocker}
          </span>
        )}
        {projectTaskNextAction(task.workflow) && (
          <span className="block text-xs text-muted-foreground">
            Next: {projectTaskNextAction(task.workflow)}
          </span>
        )}
      </span>
    </Button>
  )
}
export function ProjectTaskList({
  tasks,
  selected,
  onSelect,
  mode
}: {
  tasks: TaskViewRow[]
  selected: string
  onSelect: (id: string) => void
  mode: 'list' | 'tree'
}) {
  const [collapsed, setCollapsed] = useState(() => new Set(readProjectTaskView().collapsed))
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = readProjectTaskView().listScrollTop
    }
  }, [])
  const toggle = (id: string) => {
    const next = new Set(collapsed)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    saveProjectTaskView({ collapsed: [...next].slice(-1000) })
    setCollapsed(next)
  }
  const parentKey = (task: TaskViewRow) =>
    task.projectKey ? JSON.stringify([task.projectKey, task.parent]) : task.parent
  const ids = new Set(tasks.map(taskViewKey))
  const render = (parent: string | null, depth = 0): React.ReactNode =>
    tasks
      .filter(
        (task) =>
          mode === 'list' ||
          (parent ? parentKey(task) === parent : !task.parent || !ids.has(parentKey(task) ?? ''))
      )
      .map((task) => (
        <div key={taskViewKey(task)} className={cn(depth > 0 && 'ml-4 border-l pl-2')}>
          {mode === 'tree' && tasks.some((child) => parentKey(child) === taskViewKey(task)) && (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={!collapsed.has(taskViewKey(task))}
              onClick={() => toggle(taskViewKey(task))}
            >
              {collapsed.has(taskViewKey(task)) ? 'Expand' : 'Collapse'} {task.title}
            </Button>
          )}
          <TaskRow task={task} selected={selected === taskViewKey(task)} onSelect={onSelect} />
          {mode === 'tree' &&
            depth < 20 &&
            !collapsed.has(taskViewKey(task)) &&
            render(taskViewKey(task), depth + 1)}
        </div>
      ))
  return (
    <div
      ref={listRef}
      onScroll={(event) => saveProjectTaskView({ listScrollTop: event.currentTarget.scrollTop })}
      className="scrollbar-sleek min-h-0 space-y-1 overflow-auto p-2"
    >
      {render(null)}
    </div>
  )
}
