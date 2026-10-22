import React from 'react'
import { ChevronDown, GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { HostHeaderRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { HostSectionHeaderMenu } from '../../HostSectionHeaderMenu'
import { stopRepoHeaderMenuEvent } from './header-event-guards'
import { getHostHeaderDetail } from './host-header-detail'

export function HostSectionHeader({
  row,
  onToggle,
  onDragPointerDown,
  dragging
}: {
  row: HostHeaderRow
  onToggle: () => void
  onDragPointerDown?: (event: React.PointerEvent<HTMLElement>) => void
  dragging?: boolean
}): React.JSX.Element {
  const isBlocked = row.health === 'blocked'
  const isDisconnected = row.health === 'disconnected'
  const detail = getHostHeaderDetail(row)
  return (
    <div className="flex h-9 items-center border-y border-worktree-sidebar-border bg-background/80 px-2">
      <div
        role="button"
        tabIndex={0}
        data-host-header-drag-id={row.hostId}
        aria-expanded={!row.collapsed}
        className={cn(
          'group/host-header flex h-8 w-full cursor-pointer items-center gap-1 px-0.5 text-left text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring',
          (isBlocked || row.health === 'error') && 'text-destructive',
          dragging && 'pointer-events-none opacity-0'
        )}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <ChevronDown
          className={cn(
            'size-3 shrink-0 transition-transform motion-reduce:transition-none',
            row.collapsed && '-rotate-90'
          )}
        />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 truncate text-[11px] font-semibold uppercase tracking-wider leading-none',
              isDisconnected ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {row.label}
          </span>
          {detail ? (
            <span
              className={cn(
                'shrink-0 truncate text-[10px] leading-none',
                detail.isWarning ? 'text-destructive' : 'text-muted-foreground/70'
              )}
            >
              {detail.text}
            </span>
          ) : null}
        </div>
        {onDragPointerDown && (
          <span
            aria-hidden
            className="flex size-5 shrink-0 cursor-grab items-center justify-center opacity-0 group-hover/host-header:opacity-100 active:cursor-grabbing"
            onPointerDown={(event) => {
              event.stopPropagation()
              onDragPointerDown(event)
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <GripVertical className="size-3" />
          </span>
        )}
        <span
          data-host-header-action=""
          className="flex shrink-0 items-center"
          onPointerDown={stopRepoHeaderMenuEvent}
          onMouseDown={stopRepoHeaderMenuEvent}
          onPointerUp={stopRepoHeaderMenuEvent}
          onMouseUp={stopRepoHeaderMenuEvent}
          onClick={stopRepoHeaderMenuEvent}
          onKeyDown={stopRepoHeaderMenuEvent}
        >
          <HostSectionHeaderMenu row={row} />
        </span>
      </div>
    </div>
  )
}
