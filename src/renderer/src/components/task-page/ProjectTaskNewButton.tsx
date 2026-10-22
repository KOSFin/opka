import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { TaskProjectScope } from './project-task-projects'

export function ProjectTaskNewButton({
  projects,
  selected,
  onCreate
}: {
  projects: TaskProjectScope[]
  selected?: TaskProjectScope
  onCreate: (key: string) => void
}) {
  const ready = projects.filter((project) => project.state === 'configured')
  if (selected) {
    return (
      <Button disabled={selected.state !== 'configured'} onClick={() => onCreate(selected.key)}>
        New task
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={!ready.length}>New task</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <div className="scrollbar-sleek max-h-72 overflow-auto">
          {ready.map((project) => (
            <DropdownMenuItem key={project.key} onSelect={() => onCreate(project.key)}>
              {project.name} · {project.hostLabel}
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
