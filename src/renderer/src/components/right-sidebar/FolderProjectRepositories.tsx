import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import { RepositorySourceControl } from './RepositorySourceControl'
import { useState } from 'react'
import { FolderGit2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspace-execution-host'
import {
  readSourceControlView,
  updateSourceControlView
} from './source-control/panel/source-control-view-memory'

export function FolderProjectRepositories({
  project,
  repositories,
  activeWorktreeId
}: {
  project: FolderWorkspace
  repositories: Repo[]
  activeWorktreeId: string | null
}): React.JSX.Element {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const groups = useAppStore((s) => s.projectGroups)
  const projectName =
    groups.find((group) => group.id === project.projectGroupId)?.name ?? project.name
  const activeRepoId = repositories.find((repo) =>
    worktreesByRepo[repo.id]?.some((entry) => entry.id === activeWorktreeId)
  )?.id
  const selectionKey = JSON.stringify([
    'repository-picker',
    getFolderWorkspaceHostId(project, groups),
    project.id
  ])
  const [selection, setSelection] = useState({
    context: activeRepoId,
    id: readSourceControlView(selectionKey).repositoryId ?? activeRepoId ?? repositories[0]?.id
  })
  const selectedId = selection.context === activeRepoId ? selection.id : activeRepoId
  const selected = repositories.find((repo) => repo.id === selectedId) ?? repositories[0]
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-label="Project repositories"
    >
      <div className="border-b border-border px-3 py-2">
        <h2 className="truncate text-sm font-medium">{projectName}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {translate(
            'fork.navigation.repositorySourceControl',
            'Source Control · {{count}} repositories',
            { count: repositories.length }
          )}
        </p>
      </div>
      <div
        className="scrollbar-sleek max-h-40 shrink-0 overflow-y-auto border-b border-border p-1"
        role="group"
        aria-label="Repositories"
      >
        {repositories.map((repo) => (
          <Button
            key={repo.id}
            variant={repo.id === selected?.id ? 'secondary' : 'ghost'}
            size="sm"
            className="w-full justify-start"
            aria-pressed={repo.id === selected?.id}
            aria-label={`Source Control for ${repo.displayName}`}
            onClick={() => {
              setSelection({ context: activeRepoId, id: repo.id })
              updateSourceControlView(selectionKey, (previous) => ({
                ...previous,
                repositoryId: repo.id
              }))
            }}
          >
            <FolderGit2 className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{repo.displayName}</span>
          </Button>
        ))}
      </div>
      {selected && (
        <RepositorySourceControl
          key={selected.id}
          repo={selected}
          worktrees={worktreesByRepo[selected.id] ?? []}
          activeWorktreeId={activeWorktreeId}
        />
      )}
      {repositories.length === 0 && (
        <p className="p-3 text-xs text-muted-foreground">
          {translate(
            'fork.navigation.noRegisteredRepositories',
            'No registered Git repositories in this project. Add repositories from the project folder using Add Project.'
          )}
        </p>
      )}
    </section>
  )
}
