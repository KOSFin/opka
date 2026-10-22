import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getProjectGroupHostId } from '@/store/slices/project-group-owner-routing'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import {
  isConfirmedStaleFolderPathStatus,
  type FolderWorkspacePathStatus
} from '../../../../../../shared/folder-workspace-path-status'
import { ProjectHeaderActions } from '../../ProjectHeaderActions'
import { getRepoHeaderCreateState } from '../../repo-header-create-state'
import { ProjectChatButton } from './ProjectChatButton'
import {
  ProjectGroupCreateWorkspaceButton,
  ProjectGroupHeaderMenu
} from './project-group-header-actions'
import {
  RepoHeaderCreateWorkspaceButton,
  RepoHeaderProjectActionsMenu
} from './repo-header-project-actions'
import { handleRepoHeaderCollapseAffordancePointerDown } from './header-event-guards'
import type { SectionHeaderRowContext } from './SectionHeader'

export function SectionHeaderActions({
  ctx,
  row,
  label,
  folderGroup,
  pathStatus,
  collapse
}: {
  ctx: SectionHeaderRowContext
  row: GroupHeaderRow
  label: string
  folderGroup: ProjectGroup | null
  pathStatus: FolderWorkspacePathStatus | null
  collapse: { visible: boolean; key: string; collapsed: boolean }
}) {
  const group = ctx.groupBy === 'repo' && !row.repo ? row.projectGroup : undefined
  const host = group && 'createdFrom' in group ? getProjectGroupHostId(group) : undefined
  const createState = row.repo
    ? getRepoHeaderCreateState({ repo: row.repo, label, sshGate: ctx.getRepoSshGate(row.repo) })
    : null
  const disabled =
    pathStatus?.exists === false &&
    (isConfirmedStaleFolderPathStatus(pathStatus) || pathStatus.reason === 'ambiguous-connection')
  const projectChat = folderGroup && (row.projectGroupDepth ?? 0) === 0 ? folderGroup : null
  const hasChat = !!projectChat || !!row.repo
  return (
    <div
      className="relative flex shrink-0 items-center self-stretch"
      data-project-header-action-dock
    >
      <ProjectHeaderActions className={cn(hasChat && 'can-hover:right-full can-hover:mr-1')}>
        {collapse.visible && (
          <div
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
            data-repo-header-collapse-affordance=""
            aria-hidden
            onPointerDown={handleRepoHeaderCollapseAffordancePointerDown}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              ctx.toggleGroupWithScrollAnchor(collapse.key)
            }}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', collapse.collapsed && '-rotate-90')}
            />
          </div>
        )}
        {group && typeof group.id === 'string' && (
          <ProjectGroupHeaderMenu
            groupId={group.id}
            hostId={host}
            label={label}
            onRename={ctx.onRenameProjectGroup}
            onDelete={ctx.onDeleteProjectGroup}
          />
        )}
        {folderGroup && (
          <ProjectGroupCreateWorkspaceButton
            projectGroup={folderGroup}
            label={label}
            pathStatus={pathStatus}
            disabled={disabled}
            onCreate={ctx.onCreateFolderWorkspace}
          />
        )}
        {row.repo && ctx.groupBy === 'repo' && (
          <>
            <RepoHeaderProjectActionsMenu
              repo={row.repo}
              label={label}
              projectGroups={ctx.projectGroups}
              actions={ctx.projectActions}
            />
            <RepoHeaderCreateWorkspaceButton
              repo={row.repo}
              label={label}
              createState={createState}
              onCreateForRepo={ctx.projectActions.onCreateForRepo}
            />
          </>
        )}
      </ProjectHeaderActions>
      {projectChat && <ProjectChatButton scope={{ kind: 'project', group: projectChat }} />}
      {row.repo && <ProjectChatButton scope={{ kind: 'repository', repo: row.repo }} />}
    </div>
  )
}
