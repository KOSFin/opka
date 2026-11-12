// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AutomationEditorDialog, type AutomationDraft } from './AutomationEditorDialog'

vi.mock('./AutomationEditorPromptSection', () => ({
  AutomationEditorPromptSection: () => <div>Agent prompt</div>
}))
vi.mock('./AutomationEditorSettingsSidebar', () => ({
  AutomationEditorSettingsSidebar: () => null
}))
vi.mock('./AutomationEditorPromptEditor', () => ({ getAutomationPromptEditorRoot: () => null }))

const draft: AutomationDraft = {
  name: '',
  prompt: '',
  agentId: 'codex',
  extraAgentArgs: '',
  projectId: '',
  workspaceMode: 'existing',
  workspaceId: '',
  baseBranch: '',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '30',
  preset: 'daily',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  savedSchedule: null,
  missedRunGraceMinutes: '720',
  scheduleWarning: null
}

afterEach(cleanup)

it('offers agent and script execution in the existing automation editor', () => {
  function Editor() {
    const [executionType, setExecutionType] = useState<'agent' | 'command'>('agent')
    return (
      <AutomationEditorDialog
        open
        isEditing={false}
        isSaving={false}
        canSave
        executionType={executionType}
        onExecutionTypeChange={setExecutionType}
        commandEditor={<div>Script and condition</div>}
        repos={[]}
        projectHostSetups={[]}
        automationYamlHooksByRepoKey={{}}
        getAutomationHooksCacheKey={(id) => id}
        repoMap={new Map()}
        worktrees={[]}
        settings={null}
        draft={draft}
        onProjectChange={vi.fn()}
        onOpenChange={vi.fn()}
        onDraftChange={vi.fn()}
        onSetupDecisionTouched={vi.fn()}
        onApplyTemplate={vi.fn()}
        onSave={vi.fn()}
      />
    )
  }
  render(<Editor />)
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByText('Agent prompt')).toBeTruthy()
  fireEvent.click(screen.getByRole('combobox', { name: 'Automation type' }))
  fireEvent.click(screen.getByRole('option', { name: 'Script with optional agent' }))
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByText('Script and condition')).toBeTruthy()
  expect(screen.queryByText('Agent prompt')).toBeNull()
})
