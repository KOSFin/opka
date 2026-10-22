import { translate } from '@/i18n/i18n'
import { SourceControlPanelReady } from './panel-ready'
import { useSourceControlPanelModel } from './use-panel-model'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

/** Resolves the panel model and guards the two states that have no source control to show. */
export function SourceControlPanel({ worktreeId }: { worktreeId?: string } = {}) {
  const model = useSourceControlPanelModel(worktreeId)
  const { activeRepo, activeWorktree, isFolder, worktreePath } = model
  const { refreshActiveGitStatus } = model
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!worktreeId) {
      return
    }
    let cancelled = false
    const controller = new AbortController()
    setError('')
    void refreshActiveGitStatus(controller.signal).catch((cause: unknown) => {
      if (!cancelled) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [worktreeId, refreshActiveGitStatus, revision])

  if (!activeWorktree || !activeRepo || !worktreePath) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        {translate(
          'auto.components.right.sidebar.SourceControl.c07b236287',
          'Select a workspace to view changes'
        )}
      </div>
    )
  }
  if (isFolder) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        {translate(
          'auto.components.right.sidebar.SourceControl.e131cd7128',
          'Source Control is only available for Git repositories'
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
          <Button variant="outline" size="xs" onClick={() => setRevision((value) => value + 1)}>
            {translate('fork.navigation.retryRepository', 'Retry')}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <SourceControlPanelReady
          activeRepo={activeRepo}
          activeWorktree={activeWorktree}
          currentWorktreeId={activeWorktree.id}
          model={model}
          worktreePath={worktreePath}
        />
      </div>
    </div>
  )
}
