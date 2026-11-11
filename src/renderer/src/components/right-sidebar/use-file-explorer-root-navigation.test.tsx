// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFileExplorerRootNavigation } from './use-file-explorer-root-navigation'

const actions = vi.hoisted(() => ({
  clearPendingExplorerReveal: vi.fn(),
  setExplorerDisplayRootForWorktree: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => actions } }))
afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())
const options = [
  { value: '/', label: 'Repository root' },
  { value: 'app', label: 'app' }
]

it('offers a return after an outside reveal and clears it on explicit navigation', () => {
  const { result, rerender } = renderHook(
    ({ choice }) => useFileExplorerRootNavigation('wt', choice, options),
    { initialProps: { choice: 'app' } }
  )
  act(() => result.current.revealOutsideRoot())
  expect(actions.setExplorerDisplayRootForWorktree).toHaveBeenCalledWith('wt', '/')
  expect(actions.clearPendingExplorerReveal).not.toHaveBeenCalled()
  rerender({ choice: '/' })
  expect(result.current.returnRoot?.value).toBe('app')
  act(() => result.current.selectRoot('app'))
  expect(actions.clearPendingExplorerReveal).toHaveBeenCalledOnce()
  expect(actions.setExplorerDisplayRootForWorktree).toHaveBeenLastCalledWith('wt', 'app')
  expect(result.current.returnRoot).toBeNull()
})

it('never returns into another workspace or a removed sparse directory', () => {
  const { result, rerender } = renderHook(
    ({ id, choice, roots }) => useFileExplorerRootNavigation(id, choice, roots),
    { initialProps: { id: 'first', choice: 'app', roots: options } }
  )
  act(() => result.current.revealOutsideRoot())
  rerender({ id: 'second', choice: '/', roots: options })
  expect(result.current.returnRoot).toBeNull()
  rerender({ id: 'first', choice: '/', roots: [options[0]] })
  expect(result.current.returnRoot).toBeNull()
})

it('does not manufacture a return target when already at the repository root', () => {
  const { result } = renderHook(() => useFileExplorerRootNavigation('wt', '/', options))
  act(() => result.current.revealOutsideRoot())
  expect(result.current.returnRoot).toBeNull()
  expect(actions.setExplorerDisplayRootForWorktree).not.toHaveBeenCalled()
})

it('navigates ordinary folders with bounded back, forward and up without crossing workspaces', () => {
  const { result, rerender } = renderHook(
    ({ id, choice }) => useFileExplorerRootNavigation(id, choice, null),
    { initialProps: { id: 'first', choice: '/' } }
  )
  act(() => result.current.selectRoot('src'))
  expect(actions.setExplorerDisplayRootForWorktree).toHaveBeenLastCalledWith('first', 'src')
  rerender({ id: 'first', choice: 'src' })
  act(() => result.current.selectRoot('src/lib'))
  rerender({ id: 'first', choice: 'src/lib' })
  expect(result.current.canGoBack).toBe(true)
  act(() => result.current.goBack())
  expect(actions.setExplorerDisplayRootForWorktree).toHaveBeenLastCalledWith('first', 'src')
  rerender({ id: 'first', choice: 'src' })
  expect(result.current.canGoForward).toBe(true)
  act(() => result.current.goForward())
  expect(actions.setExplorerDisplayRootForWorktree).toHaveBeenLastCalledWith('first', 'src/lib')
  rerender({ id: 'first', choice: 'src/lib' })
  act(() => result.current.goUp())
  expect(actions.setExplorerDisplayRootForWorktree).toHaveBeenLastCalledWith('first', 'src')
  rerender({ id: 'second', choice: '/' })
  expect(result.current.canGoBack).toBe(false)
  act(() => result.current.goBack())
  expect(actions.setExplorerDisplayRootForWorktree).not.toHaveBeenCalledWith('second', 'src/lib')
})

it('refuses root escapes before recording history or changing the view', () => {
  const { result } = renderHook(() => useFileExplorerRootNavigation('wt', '/', null))
  act(() => result.current.selectRoot('../etc'))
  expect(result.current.canGoBack).toBe(false)
  expect(actions.setExplorerDisplayRootForWorktree).not.toHaveBeenCalled()
})
