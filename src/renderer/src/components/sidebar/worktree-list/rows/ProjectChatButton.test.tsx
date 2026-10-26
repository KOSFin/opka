// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { makeFolderWorkspace } from '@/components/worktree-jump-palette-test-fixtures'
import { ProjectChatButton } from './ProjectChatButton'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  activateFolder: vi.fn(),
  activateRepo: vi.fn(),
  focus: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: { activeGroupIdByWorktree: Record<string, string> }) => unknown) =>
    select({ activeGroupIdByWorktree: {} })
}))
vi.mock('./open-project-folder', () => ({ getOrCreateProjectFolder: mocks.prepare }))
vi.mock('./open-repository-working-copy', () => ({ getRepositoryMainWorkingCopy: vi.fn() }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateFolder,
  activateAndRevealWorktree: mocks.activateRepo
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: mocks.focus }))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({
    children,
    onOpenChange
  }: {
    children: ReactNode
    onOpenChange: (open: boolean) => void
  }) => (
    <div>
      <button onClick={() => onOpenChange(true)}>Open picker</button>
      <button onClick={() => onOpenChange(false)}>Close picker</button>
      {children}
    </div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('@/components/tab-bar/QuickLaunchButton', () => ({
  QuickLaunchAgentMenuItems: ({
    onFocusTerminal,
    onFocusChat
  }: {
    onFocusTerminal: (id: string) => void
    onFocusChat?: (id: string) => void
  }) => (
    <>
      <button onClick={() => onFocusTerminal('created-terminal')}>Pick terminal</button>
      <button onClick={() => onFocusChat?.('created-chat')}>Pick chat</button>
    </>
  )
}))

const group: ProjectGroup = {
  id: 'project',
  name: 'Project',
  parentPath: '/project',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0,
  executionHostId: 'runtime:fixture'
}
const folder = makeFolderWorkspace({
  id: 'prepared-folder',
  projectGroupId: group.id,
  folderPath: '/project'
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.prepare.mockResolvedValue(folder)
})
afterEach(cleanup)

it('opening and cancelling a ready picker neither activates a workspace nor starts a surface', async () => {
  render(<ProjectChatButton scope={{ kind: 'project', group }} />)
  fireEvent.click(screen.getByText('Open picker'))
  await screen.findByText('Pick terminal')
  fireEvent.click(screen.getByText('Close picker'))
  expect(mocks.prepare).toHaveBeenCalledOnce()
  expect(mocks.activateFolder).not.toHaveBeenCalled()
  expect(mocks.activateRepo).not.toHaveBeenCalled()
  expect(mocks.focus).not.toHaveBeenCalled()
})

it.each(['Pick terminal', 'Pick chat'])(
  'reveals the owner only after the %s surface exists',
  async (label) => {
    render(<ProjectChatButton scope={{ kind: 'project', group }} />)
    fireEvent.click(screen.getByText('Open picker'))
    fireEvent.click(await screen.findByText(label))
    expect(mocks.activateFolder).toHaveBeenCalledExactlyOnceWith(folder.id, {
      executionHostId: 'runtime:fixture',
      providesInitialSurface: true,
      navigationIntent: 'user-open'
    })
    expect(mocks.focus).toHaveBeenCalledTimes(label === 'Pick terminal' ? 1 : 0)
  }
)

it('ignores preparation finishing after the picker was cancelled', async () => {
  let finish: ((value: typeof folder) => void) | undefined
  mocks.prepare.mockReturnValue(
    new Promise<typeof folder>((resolve) => {
      finish = resolve
    })
  )
  render(<ProjectChatButton scope={{ kind: 'project', group }} />)
  fireEvent.click(screen.getByText('Open picker'))
  fireEvent.click(screen.getByText('Close picker'))
  finish?.(folder)
  await waitFor(() => expect(screen.queryByText('Pick terminal')).toBeNull())
  expect(mocks.activateFolder).not.toHaveBeenCalled()
})
