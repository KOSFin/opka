import type React from 'react'
import { cn } from '@/lib/utils'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'
import { FileExplorerQueryStrip } from './FileExplorerQueryStrip'

export function FileExplorerQueryRows({
  view,
  onSelectView,
  nameFilter,
  contentsQuery,
  searchFilters
}: {
  view: RightSidebarExplorerView
  onSelectView: (view: RightSidebarExplorerView) => void
  nameFilter: React.ReactNode
  contentsQuery: React.ReactNode
  searchFilters: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <FileExplorerQueryStrip view={view} onSelectView={onSelectView}>
        {/* Keep both query rows mounted so switching modes does not remount the input. */}
        <div className="relative min-h-7">
          <div
            className={cn(
              view !== 'files' && 'pointer-events-none invisible absolute inset-x-0 top-0'
            )}
          >
            {nameFilter}
          </div>
          <div
            className={cn(
              view !== 'search' && 'pointer-events-none invisible absolute inset-x-0 top-0'
            )}
          >
            {contentsQuery}
          </div>
        </div>
      </FileExplorerQueryStrip>
      <div
        className={cn(
          'border-b border-border px-2 pb-1.5',
          view !== 'search' && 'pointer-events-none invisible h-0 overflow-hidden border-b-0 p-0'
        )}
      >
        {searchFilters}
      </div>
    </>
  )
}
