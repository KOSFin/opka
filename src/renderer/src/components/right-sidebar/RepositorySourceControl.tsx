import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getRepositoryMainWorkingCopy } from '../sidebar/worktree-list/rows/open-repository-working-copy'
import { SourceControlPanel } from './source-control/panel/panel'
import { getWorktreeGitIdentityDisplay } from '../../../../shared/worktree/git-identity-display'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  readSourceControlView,
  updateSourceControlView
} from './source-control/panel/source-control-view-memory'

function branchLabel(worktree: Worktree): string {
  const identity = getWorktreeGitIdentityDisplay(worktree)
  return identity?.kind === 'branch' ? identity.branchName : (identity?.sourceControlLabel ?? '')
}

export function RepositorySourceControl({
  repo,
  worktrees,
  activeWorktreeId
}: {
  repo: Repo
  worktrees: Worktree[]
  activeWorktreeId: string | null
}) {
  const selectionKey = JSON.stringify([
    'working-copy-picker',
    getRepoExecutionHostId(repo),
    repo.id
  ])
  const [selected, setSelected] = useState<string | null>(
    () => readSourceControlView(selectionKey).workingCopyId
  )
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const current = worktrees.find((entry) => entry.id === activeWorktreeId)
  const currentId = current?.id
  const [previousCurrentId, setPreviousCurrentId] = useState(currentId)
  if (previousCurrentId !== currentId) {
    setPreviousCurrentId(currentId)
    if (currentId) {
      setSelected(currentId)
    }
  }
  const main = worktrees.find((entry) => entry.isMainWorktree)
  const worktree = worktrees.find((entry) => entry.id === selected) ?? current ?? main
  useEffect(() => {
    if (worktree) {
      return
    }
    let cancelled = false
    setError('')
    void getRepositoryMainWorkingCopy(repo)
      .then((entry) => {
        if (!cancelled) {
          setSelected(entry.id)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      cancelled = true
    }
  }, [repo, worktree, retry])
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {worktrees.length > 1 && worktree && (
        <div className="px-3 py-2">
          <Select
            value={worktree.id}
            onValueChange={(id) => {
              setSelected(id)
              updateSourceControlView(selectionKey, (previous) => ({
                ...previous,
                workingCopyId: id
              }))
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={translate('fork.navigation.workingCopyFor', 'Working copy for {{name}}', {
                name: repo.displayName
              })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {worktrees.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.displayName} · {branchLabel(entry)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {worktree ? (
        <div className="min-h-0 flex-1" data-source-control-repository={repo.id}>
          <SourceControlPanel key={worktree.id} worktreeId={worktree.id} />
        </div>
      ) : (
        <div className="p-3 text-xs text-muted-foreground" role={error ? 'alert' : 'status'}>
          {error || translate('fork.navigation.loadingRepository', 'Loading repository…')}
          {error && (
            <Button
              variant="outline"
              size="xs"
              className="mt-2"
              onClick={() => setRetry((value) => value + 1)}
            >
              {translate('fork.navigation.retryRepository', 'Retry')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
