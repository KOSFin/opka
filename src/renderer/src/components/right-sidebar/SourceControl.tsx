import React from 'react'
import { SourceControlPanel } from './source-control/panel/panel'
import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { FolderProjectRepositories } from './FolderProjectRepositories'
import { getFolderProjectRepositories } from './folder-project-repositories'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { useActiveWorktree } from '@/store/selectors'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspace-execution-host'
import { translate } from '@/i18n/i18n'

export { HostedReviewHeaderLink } from './source-control/review/hosted-review-header-chrome'

export {
  CompareSummary,
  CompareSummaryToolbarButton,
  shouldRefreshBranchCompareForRemoteStatus,
  shouldRefreshBranchCompareForStatusHead,
  shouldShowCompareSummary
} from './source-control/sync/compare-summary'
export {
  ConflictSummaryCard,
  OperationBanner
} from './source-control/listing/conflict-status-cards'
export { TooManyChangesBanner } from './source-control/listing/too-many-changes-banner'
export { ActionButton } from './source-control/listing/action-button'
export { BRANCH_REFRESH_INTERVAL_MS } from './source-control/sync/use-branch-compare'
export { CommitArea } from './source-control/commit/commit-area'
export { handleSourceControlCommitShortcut } from './source-control/commit/commit-shortcut'
export {
  resolveSourceControlBaseRef,
  resolveSourceControlCompareBaseRef,
  resolveSourceControlPickerBaseRef,
  shouldClearBranchCompareForMissingBase
} from './source-control/sync/base-ref-resolution'
export {
  normalizeSourceControlViewMode,
  readCommitDraftForWorktree,
  writeCommitDraftForWorktree
} from './source-control/commit/commit-drafts'
export {
  pickDefaultSourceControlAgent,
  shouldRenderCommitArea
} from './source-control/commit/component-gates'
export {
  clearRemoteActionErrorsForCompletedConflictOperations,
  refreshSourceControlAfterRemoteAction
} from './source-control/sync/remote-refresh'

export {
  appendCommitFailureCustomInstruction,
  appendPushFailureCustomInstruction,
  buildCommitFailureAgentCommandInput,
  buildFixCommitFailurePrompt,
  buildFixPushFailurePrompt,
  buildPushFailureAgentCommandInput,
  buildResolveConflictsPrompt,
  buildResolvePullRequestConflictsPrompt
} from './source-control/ai/prompts'
export {
  hasConfiguredCommitMessageGenerationDefaults,
  hasConfiguredSourceControlTextGenerationDefaults
} from './source-control/ai/text-generation-defaults'

function SourceControlInner(): React.JSX.Element {
  const workspaceKey = useAppStore((s) => s.activeWorkspaceKey ?? s.activeWorktreeId)
  const activeHost = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const folders = useAppStore((s) => s.folderWorkspaces) ?? []
  const projectGroups = useAppStore((s) => s.projectGroups) ?? []
  const repos = useAppStore((s) => s.repos) ?? []
  const worktree = useActiveWorktree()
  const repo = repos.find((entry) => entry.id === worktree?.repoId)
  const scope = parseWorkspaceKey(workspaceKey ?? '')
  const state = { folderWorkspaces: folders, projectGroups, repos }
  const owner =
    scope?.type === 'folder'
      ? findFolderWorkspaceOwner(state, scope.folderWorkspaceId, activeHost ?? undefined)
      : repo
        ? folders.find((folder) =>
            getFolderProjectRepositories(state, folder).some(
              (entry) =>
                entry.id === repo.id &&
                getRepoExecutionHostId(entry) === getRepoExecutionHostId(repo)
            )
          )
        : null
  const project = folders.find((entry) => entry === owner)
  if (project) {
    return (
      <FolderProjectRepositories
        key={`${getFolderWorkspaceHostId(project, projectGroups)}:${project.id}`}
        project={project}
        repositories={getFolderProjectRepositories(state, project)}
        activeWorktreeId={scope?.type === 'folder' ? null : (worktree?.id ?? null)}
      />
    )
  }
  if (scope?.type === 'folder') {
    return (
      <div role="alert" className="p-3 text-xs text-muted-foreground">
        {translate(
          'fork.navigation.projectUnavailable',
          'Project folder unavailable. Reconnect its host and select the project again.'
        )}
      </div>
    )
  }
  return <SourceControlPanel />
}
const SourceControl = React.memo(SourceControlInner)
export default SourceControl
