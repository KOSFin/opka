import React, { useState } from 'react'
import { Ellipsis, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getFolderWorkspacePathStatusDescription } from '@/lib/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspace-path-status'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { REPO_HEADER_ACTION_BUTTON_CLASS } from '../../repo-header-action-button-class'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RepositoryIconTabs } from '@/components/settings/RepositoryIconTabs'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { useAppStore } from '@/store'
import type { RepoIcon } from '../../../../../../shared/repo-icon'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle,
  stopRepoHeaderMenuEvent
} from './header-event-guards'

export function ProjectGroupHeaderMenu({
  groupId,
  hostId,
  label,
  groupIcon,
  onRename,
  onDelete
}: {
  groupId: string
  /** Owner host of the group row, so rename/delete route to the host that holds it. */
  hostId?: ExecutionHostId
  label: string
  groupIcon?: RepoIcon | null
  onRename: (groupId: string, currentName: string, hostId?: ExecutionHostId) => void
  onDelete: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
}): React.JSX.Element {
  const [iconOpen, setIconOpen] = useState(false)
  const [iconPending, setIconPending] = useState(false)
  const updateProjectGroup = useAppStore((state) => state.updateProjectGroup)
  const setIcon = async (icon: RepoIcon | null) => {
    if (iconPending) {
      return
    }
    setIconPending(true)
    const saved = await updateProjectGroup(groupId, { groupIcon: icon }, { hostId })
    setIconPending(false)
    if (saved) {
      setIconOpen(false)
    }
  }
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={REPO_HEADER_ACTION_BUTTON_CLASS}
            data-repo-header-action=""
            aria-label={translate(
              'auto.components.sidebar.WorktreeList.79465e9034',
              'Project actions for {{value0}}',
              { value0: label }
            )}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={stopRepoHeaderKeyboardToggle}
            onPointerDown={handleRepoHeaderActionPointerDown}
          >
            <Ellipsis className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={6}
          // Why: Radix portals keep React bubbling through the project header; block menu events from arming row drag/collapse.
          onPointerDown={stopRepoHeaderMenuEvent}
          onMouseDown={stopRepoHeaderMenuEvent}
          onPointerUp={stopRepoHeaderMenuEvent}
          onMouseUp={stopRepoHeaderMenuEvent}
          onClick={stopRepoHeaderMenuEvent}
          onKeyDown={stopRepoHeaderMenuEvent}
        >
          <DropdownMenuItem onSelect={() => onRename(groupId, label, hostId)}>
            {translate('auto.components.sidebar.WorktreeList.4d7b73658c', 'Rename project')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setIconOpen(true)}>
            Change project icon
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(groupId, label, hostId)}>
            {translate('auto.components.sidebar.WorktreeList.902115cdbe', 'Delete project')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={iconOpen} onOpenChange={setIconOpen}>
        <DialogContent onClick={stopRepoHeaderMenuEvent}>
          <DialogHeader>
            <DialogTitle>Icon for {label}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RepoIconGlyph repoIcon={groupIcon} className="size-5" />
            {groupIcon ? 'Current project icon' : 'Default folder icon'}
          </div>
          <fieldset disabled={iconPending}>
            <RepositoryIconTabs
              initialTab={groupIcon?.type === 'emoji' ? 'emoji' : 'icon'}
              selectedLucideName={groupIcon?.type === 'lucide' ? groupIcon.name : null}
              selectedEmoji={groupIcon?.type === 'emoji' ? groupIcon.emoji : ''}
              loadingGitHub={false}
              showAvatar={false}
              iconSubject="project"
              onSetIcon={(icon) => void setIcon(icon)}
              onUseGitHubAvatar={() => undefined}
            />
          </fieldset>
          <Button variant="ghost" disabled={iconPending} onClick={() => void setIcon(null)}>
            Use default folder icon
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function ProjectGroupCreateWorkspaceButton({
  projectGroup,
  label,
  pathStatus,
  disabled,
  onCreate
}: {
  projectGroup: ProjectGroup
  label: string
  pathStatus: FolderWorkspacePathStatus | null
  disabled: boolean
  onCreate: (projectGroup: ProjectGroup) => void
}): React.JSX.Element {
  const createLabel = translate(
    'auto.components.sidebar.WorktreeList.bd37a57ac8',
    'Create workspace for {{value0}}',
    { value0: label }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-repo-header-action=""
          className={cn(
            REPO_HEADER_ACTION_BUTTON_CLASS,
            disabled &&
              'cursor-not-allowed text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/60'
          )}
          aria-label={createLabel}
          aria-disabled={disabled}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onPointerDown={handleRepoHeaderActionPointerDown}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (disabled) {
              return
            }
            onCreate(projectGroup)
          }}
        >
          <Plus className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {pathStatus?.exists === false
          ? getFolderWorkspacePathStatusDescription(pathStatus)
          : createLabel}
      </TooltipContent>
    </Tooltip>
  )
}
