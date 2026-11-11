import { expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { FileExplorerRow } from './FileExplorerRow'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import { directoryNode, fileNode } from './file-explorer-tree-node-test-fixtures'
import { visit, type ReactElementLike } from './file-explorer-element-tree-test-harness'

function continuation(
  cursor: string | null,
  expanded: boolean
): {
  button: ReactElementLike | undefined
  lastRow: ReactElementLike | undefined
  loadMore: ReturnType<typeof vi.fn>
} {
  const loadMore = vi.fn()
  const rows = [directoryNode, fileNode]
  const element = Reflect.apply(FileExplorerVirtualRows, undefined, [
    {
      virtualizer: {
        getTotalSize: () => rows.length * 26,
        getVirtualItems: () =>
          rows.map((row, index) => ({ index, key: row.path, start: index * 26 })),
        measureElement: vi.fn()
      },
      worktreePath: '/repo',
      displayRootPath: '/repo',
      onLoadMoreDir: loadMore,
      inlineInputIndex: -1,
      rowProjection: createFileExplorerRowProjection(rows),
      inlineInput: null,
      handleInlineSubmit: vi.fn(),
      dismissInlineInput: vi.fn(),
      folderStatusByRelativePath: new Map(),
      statusByRelativePath: new Map(),
      ignoredByRelativePath: new Set(),
      expanded: new Set(expanded ? ['/repo/src'] : []),
      loadingDirPaths: new Set<string>(),
      selectedPaths: new Set<string>(),
      activeFileId: null,
      flashingPath: null,
      deleteShortcutLabel: 'Delete',
      dirCache: {
        '/repo/src': { children: [fileNode], nextCursor: cursor }
      },
      onClick: vi.fn(),
      onDoubleClick: vi.fn(),
      onViewFile: vi.fn(),
      onContextMenuSelect: vi.fn(),
      onCopyPaths: vi.fn(),
      onStartNew: vi.fn(),
      onStartRename: vi.fn(),
      onDuplicate: vi.fn(),
      onAddFolderAsProject: vi.fn(),
      canAddFolderAsProject: () => false,
      onOpenInTerminal: vi.fn(),
      onRequestDelete: vi.fn(),
      onCollapseFolderSubtree: vi.fn(),
      onFindInFolder: vi.fn(),
      onMoveDrop: vi.fn(),
      onDragTargetChange: vi.fn(),
      onDragSourceChange: vi.fn(),
      onDragExpandDir: vi.fn(),
      onNativeDragTargetChange: vi.fn(),
      onNativeDragExpandDir: vi.fn(),
      dropTargetDir: null,
      dragSourcePath: null,
      nativeDropTargetDir: null
    }
  ])
  const buttons: ReactElementLike[] = []
  const treeRows: ReactElementLike[] = []
  visit(element, (entry) => {
    if (entry.type === Button) {
      buttons.push(entry)
    } else if (entry.type === FileExplorerRow) {
      treeRows.push(entry)
    }
  })
  return { button: buttons[0], lastRow: treeRows.at(-1), loadMore }
}

it('renders a keyboard button at the end of the expanded folder and pages only that folder', () => {
  const { button, lastRow, loadMore } = continuation('next-page', true)
  expect(lastRow?.props.node).toEqual(fileNode)
  expect(button?.props['aria-label']).toBe('Load more files in /repo/src')
  if (!button || typeof button.props.onClick !== 'function') {
    throw new Error('nested continuation button is missing')
  }
  const stopPropagation = vi.fn()
  Reflect.apply(button.props.onClick, undefined, [{ stopPropagation }])
  expect(stopPropagation).toHaveBeenCalledOnce()
  expect(loadMore).toHaveBeenCalledWith('/repo/src', 0)
})

it('does not render a continuation for a collapsed or fully loaded folder', () => {
  expect(continuation('next-page', false).button).toBeUndefined()
  expect(continuation(null, true).button).toBeUndefined()
})
