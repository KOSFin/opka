// @vitest-environment happy-dom
import { act } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useAutomationCommandCatalog } from './use-automation-command-catalog'
import { useAutomationCommandState } from './use-automation-command-state'
import {
  listCommandAutomationsForTarget,
  listCommandAutomationsAndReportTargetsForTarget,
  commandAutomationEditorSetupsForTarget
} from './automation-command-host-client'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationCommandDefinitionV1 } from '../../../../shared/automation-command-domain'

vi.mock('./automation-command-host-client', () => ({
  listCommandAutomationsForTarget: vi.fn(),
  listCommandAutomationsAndReportTargetsForTarget: vi.fn(),
  commandAutomationEditorSetupsForTarget: vi.fn(),
  listCommandAutomationRunsForTarget: vi.fn(),
  deleteCommandAutomationForTarget: vi.fn()
}))

it('queries an explicit runtime host without falling back to the desktop on failure', async () => {
  const host: AutomationHostCatalogEntry = {
    stableKey: 'runtime:server:self',
    label: 'NEW server',
    authorityLabel: 'NEW server',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    owner: null,
    stableRef: {
      authority: { kind: 'runtime', environmentId: 'server' },
      selector: { kind: 'self' }
    }
  }
  const hosts = [host]
  let rows: readonly { definition: AutomationCommandDefinitionV1 }[] = []
  let failures: readonly string[] = []
  function Probe() {
    const result = useAutomationCommandCatalog(hosts)
    rows = result.rows
    failures = result.failures
    return null
  }
  vi.mocked(listCommandAutomationsForTarget).mockRejectedValue(new Error('connection lost'))
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => {
      root.render(<Probe />)
    })
    expect(listCommandAutomationsForTarget).toHaveBeenCalledExactlyOnceWith({
      kind: 'environment',
      environmentId: 'server'
    })
    expect(rows).toEqual([])
    expect(failures).toEqual(['NEW server: connection lost'])
  } finally {
    await act(async () => root.unmount())
  }
})

it('ignores an old host read that fails after the editor has selected another host', async () => {
  let rejectOld: (cause: Error) => void = () => {
    throw new Error('Read not started')
  }
  const oldRead = new Promise<{ definitions: AutomationCommandDefinitionV1[]; reportTargets: [] }>(
    (_resolve, reject) => {
      rejectOld = reject
    }
  )
  vi.mocked(commandAutomationEditorSetupsForTarget).mockResolvedValue([])
  vi.mocked(listCommandAutomationsAndReportTargetsForTarget).mockImplementation((target) =>
    target.kind === 'environment' && target.environmentId === 'old'
      ? oldRead
      : Promise.resolve({ definitions: [], reportTargets: [] })
  )
  const { result, rerender, unmount } = renderHook(
    ({ environmentId }) =>
      useAutomationCommandState({
        target: { kind: 'environment', environmentId },
        onChanged: vi.fn(),
        onRemoved: vi.fn()
      }),
    { initialProps: { environmentId: 'old' } }
  )
  try {
    rerender({ environmentId: 'new' })
    await waitFor(() =>
      expect(result.current.stableTarget).toEqual({ kind: 'environment', environmentId: 'new' })
    )
    await act(async () => rejectOld(new Error('Old connection lost')))
    expect(result.current.error).toBeNull()
    expect(result.current.definitions).toEqual([])
    expect(commandAutomationEditorSetupsForTarget).toHaveBeenLastCalledWith({
      kind: 'environment',
      environmentId: 'new'
    })
  } finally {
    unmount()
  }
})
