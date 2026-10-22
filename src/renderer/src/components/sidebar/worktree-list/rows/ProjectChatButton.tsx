import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { getProjectGroupHostId } from '@/store/slices/project-group-owner-routing'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { translate } from '@/i18n/i18n'
import { getOrCreateProjectFolder } from './open-project-folder'
import { getRepositoryMainWorkingCopy } from './open-repository-working-copy'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { MessageSquarePlus } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function ProjectChatButton({
  scope
}: {
  scope: { kind: 'project'; group: ProjectGroup } | { kind: 'repository'; repo: Repo }
}) {
  const generation = useRef(0)
  const [worktreeId, setWorktreeId] = useState('')
  const [error, setError] = useState('')
  const groupId = useAppStore((state) => state.activeGroupIdByWorktree?.[worktreeId] ?? '')
  const label = translate('fork.navigation.newProjectChat', 'New chat in {{name}}', {
    name: scope.kind === 'project' ? scope.group.name : scope.repo.displayName
  })
  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button
        variant="ghost"
        size={scope.kind === 'repository' ? 'icon-xs' : 'xs'}
        data-repo-header-action=""
        className="shrink-0"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        aria-label={label}
      >
        <MessageSquarePlus className="size-3.5" />
        {scope.kind === 'project' && translate('fork.navigation.newChat', 'New chat')}
      </Button>
    </DropdownMenuTrigger>
  )
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        const request = ++generation.current
        if (!open) {
          return
        }
        setError('')
        setWorktreeId('')
        const owner =
          scope.kind === 'project'
            ? getProjectGroupHostId(scope.group)
            : getRepoExecutionHostId(scope.repo)
        const workspace =
          scope.kind === 'project'
            ? getOrCreateProjectFolder(scope.group).then((folder) => ({
                id: `folder:${folder.id}`,
                folderId: folder.id
              }))
            : getRepositoryMainWorkingCopy(scope.repo).then((main) => ({
                id: main.id,
                folderId: null
              }))
        void workspace
          .then((entry) => {
            if (request !== generation.current) {
              return
            }
            if (entry.folderId) {
              activateAndRevealFolderWorkspace(entry.folderId, {
                executionHostId: owner,
                providesInitialSurface: true,
                navigationIntent: 'user-open'
              })
            } else {
              activateAndRevealWorktree(entry.id, {
                executionHostId: owner,
                providesInitialSurface: true,
                navigationIntent: 'user-open'
              })
            }
            setWorktreeId(entry.id)
          })
          .catch((cause: unknown) => {
            if (request === generation.current) {
              setError(cause instanceof Error ? cause.message : 'Could not open project')
            }
          })
      }}
    >
      {scope.kind === 'repository' ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent
        align="end"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {worktreeId ? (
          <QuickLaunchAgentMenuItems
            worktreeId={worktreeId}
            groupId={groupId}
            onFocusTerminal={focusTerminalTabSurface}
          />
        ) : (
          <p role={error ? 'alert' : 'status'} className="p-3 text-xs">
            {error || 'Opening project…'}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
