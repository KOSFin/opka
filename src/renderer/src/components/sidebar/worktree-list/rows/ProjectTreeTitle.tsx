import { ChevronDown, Folder, FolderGit2, GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import type { RepoIcon } from '../../../../../../shared/repo-icon'

export function ProjectTreeTitle({
  label,
  kind,
  collapsed,
  collapsible,
  onOpen,
  repoIcon,
  repoColor,
  onToggle,
  onReorderPointerDown
}: {
  label: string
  kind: 'project' | 'folder' | 'repository'
  collapsed: boolean
  collapsible: boolean
  onOpen?: () => void
  repoIcon?: RepoIcon | null
  repoColor?: string
  onToggle?: () => void
  onReorderPointerDown?: (event: React.PointerEvent<HTMLElement>) => void
}): React.JSX.Element {
  const Icon = kind === 'repository' ? FolderGit2 : Folder
  const TitleElement = onOpen ? 'button' : 'span'
  return (
    <>
      {onReorderPointerDown && (
        <span
          aria-hidden
          data-repo-header-drag-handle=""
          data-project-group-header-drag-handle=""
          className="absolute inset-y-0 left-0 flex w-3 cursor-grab items-center text-muted-foreground opacity-0 group-hover:opacity-100 active:cursor-grabbing"
          onPointerDown={(event) => {
            event.stopPropagation()
            onReorderPointerDown(event)
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <GripVertical className="size-3" />
        </span>
      )}
      {collapsible ? (
        <button
          type="button"
          data-repo-header-collapse-affordance=""
          aria-expanded={!collapsed}
          aria-label={translate(
            collapsed ? 'fork.navigation.expand' : 'fork.navigation.collapse',
            collapsed ? 'Expand {{name}}' : 'Collapse {{name}}',
            { name: label }
          )}
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-worktree-sidebar-accent outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onToggle?.()
          }}
        >
          <ChevronDown
            aria-hidden
            className={cn(
              'size-3 transition-transform motion-reduce:transition-none',
              collapsed && '-rotate-90'
            )}
          />
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden />
      )}
      {kind === 'repository' && repoIcon ? (
        <RepoIconGlyph repoIcon={repoIcon} color={repoColor} className="size-3.5 shrink-0" />
      ) : (
        <Icon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
          style={repoColor ? { color: repoColor } : undefined}
        />
      )}
      <TitleElement
        type={onOpen ? 'button' : undefined}
        aria-label={
          onOpen
            ? kind === 'repository'
              ? translate('fork.navigation.openRepository', 'Open repository {{name}}', {
                  name: label
                })
              : translate('fork.navigation.openProject', 'Open project {{name}}', { name: label })
            : undefined
        }
        className={cn(
          'min-w-0 truncate text-[13px] leading-4',
          onOpen &&
            'cursor-pointer rounded outline-none focus-visible:ring-1 focus-visible:ring-ring',
          kind === 'folder' ? 'text-muted-foreground' : 'font-semibold'
        )}
        onClick={
          onOpen
            ? (event) => {
                event.stopPropagation()
                onOpen()
              }
            : undefined
        }
        onKeyDown={onOpen ? (event) => event.stopPropagation() : undefined}
      >
        {label}
      </TitleElement>
      {kind !== 'folder' && (
        <span className="sr-only">
          {kind === 'project'
            ? translate('fork.navigation.project', 'Project')
            : translate('fork.navigation.repository', 'Repository')}
        </span>
      )}
    </>
  )
}
