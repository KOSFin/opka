import { Fragment } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { taskProjectKey, type TaskProjectScope } from './project-task-projects'

export function taskProjectPickerSections(projects: TaskProjectScope[]) {
  const sections = new Map<string, { name: string | null; projects: TaskProjectScope[] }>()
  for (const project of projects) {
    const grouped = Boolean(project.groupId && project.groupName)
    const key = grouped ? taskProjectKey(project.target, `group:${project.groupId}`) : project.key
    const section = sections.get(key) ?? {
      name: grouped ? (project.groupName ?? null) : null,
      projects: []
    }
    section.projects.push(project)
    sections.set(key, section)
  }
  return [...sections.values()]
}

export function taskProjectGroupOptionLabel(name: string, hostLabel: string): string {
  return `Project: ${name} · ${hostLabel}`
}

export function taskProjectRootOptionLabel(project: TaskProjectScope, grouped: boolean): string {
  return grouped
    ? `Repository: ${project.repositoryName ?? project.name} · ${project.hostLabel}`
    : `Project: ${project.name} · ${project.hostLabel}`
}

export function toggleTaskProject(
  selected: string[],
  projects: readonly Pick<TaskProjectScope, 'key'>[],
  key: string
): string[] {
  if (key === '*') {
    return selected.includes('*') ? [] : ['*']
  }
  const current = selected.includes('*') ? projects.map((project) => project.key) : selected
  return current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]
}

export function toggleTaskProjectGroup(
  selected: string[],
  projects: readonly Pick<TaskProjectScope, 'key'>[],
  groupKeys: string[]
): string[] {
  const current = selected.includes('*') ? projects.map((project) => project.key) : selected
  return groupKeys.every((key) => current.includes(key))
    ? current.filter((key) => !groupKeys.includes(key))
    : [...new Set([...current, ...groupKeys])]
}

export function taskProjectPickerLabel(projects: TaskProjectScope[], selected: string[]): string {
  const sections = taskProjectPickerSections(projects)
  const selectedKeys = selected.includes('*') ? projects.map((project) => project.key) : selected
  const included = sections.filter((section) =>
    section.projects.some((project) => selectedKeys.includes(project.key))
  )
  if (projects.length > 0 && projects.every((project) => selectedKeys.includes(project.key))) {
    return 'All projects'
  }
  if (included.length === 0) {
    return '0 projects'
  }
  const partial = included.some((section) =>
    section.projects.some((project) => !selectedKeys.includes(project.key))
  )
  if (included.length === 1) {
    const section = included[0]
    const name = section?.name ?? section?.projects[0]?.name ?? '1 project'
    return partial ? `${name} · partial` : name
  }
  return `${included.length} projects${partial ? ' · partial' : ''}`
}

export function ProjectTaskProjectPicker({
  projects,
  selected,
  onChange
}: {
  projects: TaskProjectScope[]
  selected: string[]
  onChange: (keys: string[]) => void
}) {
  const all =
    selected.includes('*') ||
    (projects.length > 0 && projects.every((p) => selected.includes(p.key)))
  const label = taskProjectPickerLabel(projects, selected)
  const sections = taskProjectPickerSections(projects)
  const selectedKeys = selected.includes('*') ? projects.map((project) => project.key) : selected
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Task projects">
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label="Task project selection">
        <DropdownMenuCheckboxItem
          checked={all}
          onCheckedChange={() => onChange(all ? [] : ['*'])}
          onSelect={(event) => event.preventDefault()}
        >
          Select all projects
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {projects.some((project) => !project.projectGroupsAvailable) ? (
          <DropdownMenuLabel>
            Some hosts cannot list project membership. Update those hosts to see project groups.
          </DropdownMenuLabel>
        ) : null}
        {sections.map((section) => {
          const groupKeys = section.projects.map((project) => project.key)
          const groupSelected = groupKeys.every((key) => selectedKeys.includes(key))
          return (
            <Fragment key={groupKeys[0]}>
              {section.name ? (
                <DropdownMenuCheckboxItem
                  checked={groupSelected}
                  onCheckedChange={() =>
                    onChange(toggleTaskProjectGroup(selected, projects, groupKeys))
                  }
                  onSelect={(event) => event.preventDefault()}
                >
                  {taskProjectGroupOptionLabel(section.name, section.projects[0]?.hostLabel ?? '')}
                </DropdownMenuCheckboxItem>
              ) : null}
              {section.projects.map((project) => (
                <DropdownMenuCheckboxItem
                  key={project.key}
                  checked={all || selected.includes(project.key)}
                  onCheckedChange={() =>
                    onChange(toggleTaskProject(selected, projects, project.key))
                  }
                  onSelect={(event) => event.preventDefault()}
                >
                  {taskProjectRootOptionLabel(project, Boolean(section.name))}
                </DropdownMenuCheckboxItem>
              ))}
            </Fragment>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
