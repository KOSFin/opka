// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  api,
  installAutomationsPageHarness,
  renderPage,
  scopedList
} from './automations-page-test-harness'
import { makeAutomation } from './automations-page-fixtures'
import { commandDefinitionFromDraft, emptyAutomationCommandDraft } from './automation-command-draft'
import { AutomationCommandDefinitionV1 } from '../../../../shared/automation-command-domain'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  listCommandAutomationsForTarget,
  listCommandAutomationsAndReportTargetsForTarget,
  commandAutomationEditorSetupsForTarget,
  listCommandAutomationRunsForTarget,
  listCommandAutomationHistoryPageForTarget
} from './automation-command-host-client'

vi.mock('./automation-command-host-client', () => ({
  listCommandAutomationsForTarget: vi.fn(),
  listCommandAutomationsAndReportTargetsForTarget: vi.fn(),
  commandAutomationEditorSetupsForTarget: vi.fn(),
  listCommandAutomationRunsForTarget: vi.fn(),
  listCommandAutomationHistoryPageForTarget: vi.fn()
}))

installAutomationsPageHarness()

it.each([false, true])(
  'opens a script row through the page controller with agent rows present=%s',
  async (withAgent) => {
    const setup: ProjectHostSetup = {
      id: 'script-setup',
      projectId: 'project',
      hostId: 'local',
      repoId: 'project',
      path: '/synthetic/folder',
      displayName: 'Synthetic folder',
      setupState: 'ready',
      setupMethod: 'imported-existing-folder',
      createdAt: 1,
      updatedAt: 1
    }
    const definition = AutomationCommandDefinitionV1.parse({
      ...commandDefinitionFromDraft(
        {
          ...emptyAutomationCommandDraft(),
          name: 'Script example',
          setupId: setup.id,
          commandText: 'true',
          timezone: 'UTC'
        },
        setup,
        1,
        'script-create'
      ),
      id: 'script-1',
      revision: 1,
      nextRunAt: 1,
      createdAt: 1,
      updatedAt: 1
    })
    const agents = withAgent ? [makeAutomation({ name: 'Agent example' })] : []
    api.automations.list.mockResolvedValue(agents)
    scopedList(agents)
    vi.mocked(listCommandAutomationsForTarget).mockResolvedValue([definition])
    vi.mocked(listCommandAutomationsAndReportTargetsForTarget).mockResolvedValue({
      definitions: [definition],
      reportTargets: []
    })
    vi.mocked(commandAutomationEditorSetupsForTarget).mockResolvedValue([setup])
    vi.mocked(listCommandAutomationRunsForTarget).mockResolvedValue([])
    vi.mocked(listCommandAutomationHistoryPageForTarget).mockResolvedValue({
      runs: [],
      nextCursor: null
    })

    await renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Script example' })).toBeTruthy())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Script example' })))
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Command automation details' })).toBeTruthy()
    )
    expect(screen.getByRole('heading', { name: 'Script example' })).toBeTruthy()
    expect(screen.queryByTestId('list-panel')).toBeNull()

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Back to automations' }))
    )
    expect(screen.getByTestId('list-panel')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Command automation details' })).toBeNull()
    if (withAgent) {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Agent example' })))
      expect(screen.getByTestId('detail-name').textContent).toBe('Agent example')
      expect(screen.queryByRole('region', { name: 'Command automation details' })).toBeNull()
    } else {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Script example' })))
      await act(async () => fireEvent.keyDown(window, { key: 'Escape' }))
      expect(screen.getByTestId('list-panel')).toBeTruthy()
      expect(screen.queryByRole('region', { name: 'Command automation details' })).toBeNull()
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Runs' })))
      expect(screen.queryByRole('region', { name: 'Command automation details' })).toBeNull()
    }
  }
)
