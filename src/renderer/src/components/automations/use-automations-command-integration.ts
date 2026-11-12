import { useEffect, useState } from 'react'
import { useAppStore } from '../../store'
import type { AutomationsPageController } from './use-automations-page-controller'
import { getAutomationAuthorityTarget, getAutomationListTarget } from './automation-host-client'
import { getToneForAutomationRunStatus } from './automation-list-last-run'
import { useAutomationCommandState } from './use-automation-command-state'
import {
  useAutomationCommandCatalog,
  type AutomationCommandCatalogRow
} from './use-automation-command-catalog'

export function useAutomationsCommandIntegration(controller: AutomationsPageController) {
  const requestedReport = useAppStore((state) => state.pendingCommandAutomationReportNavigation)
  const [executionType, setExecutionType] = useState<'agent' | 'command'>('agent')
  const {
    selectedCommandAutomation: selected,
    setSelectedCommandAutomation: setSelected,
    setIsDetailOpen
  } = controller.local
  const catalog = useAutomationCommandCatalog(controller.list.hostCatalog.entries)
  const resolution = controller.destination.createDestination.control.resolution
  const createTarget =
    resolution.status === 'ready'
      ? getAutomationAuthorityTarget(resolution.authority)
      : getAutomationListTarget(controller.store.settings)
  const command = useAutomationCommandState({
    target: selected?.target ?? createTarget,
    requestedReport,
    selectionId: selected?.definition.id,
    onChanged: catalog.refresh,
    onRemoved() {
      setSelected(null)
      setIsDetailOpen(false)
    }
  })
  useEffect(() => {
    if (!requestedReport) {
      return
    }
    const matches = catalog.rows.filter((row) => row.definition.id === requestedReport.automationId)
    // A bare report link cannot safely choose between equal IDs on different hosts.
    if (matches.length === 1) {
      setSelected(matches[0])
      setIsDetailOpen(true)
    }
  }, [requestedReport, catalog.rows, setIsDetailOpen, setSelected])
  const filter = controller.local.listFilter
  const scope = controller.list.hostCatalog.resolution.entry?.stableKey
  const query = controller.local.listSearchQuery.trim().toLowerCase()
  const rows = catalog.rows.filter((row) => {
    if (scope && row.host.stableKey !== scope) {
      return false
    }
    if (filter.hostStableKeys?.length && !filter.hostStableKeys.includes(row.host.stableKey)) {
      return false
    }
    if (filter.status !== 'all' && row.definition.enabled !== (filter.status === 'enabled')) {
      return false
    }
    if (
      filter.agentIds.length &&
      (!row.definition.execution.agent || !filter.agentIds.includes('codex'))
    ) {
      return false
    }
    if (filter.lastRun === 'never' && row.definition.lastRunAt) {
      return false
    }
    if (filter.lastRun === 'failed' || filter.lastRun === 'succeeded') {
      if (!row.lastRun || getToneForAutomationRunStatus(row.lastRun.status) !== filter.lastRun) {
        return false
      }
    }
    return `${row.definition.name} ${row.host.label} ${row.definition.runContext?.path ?? ''}`
      .toLowerCase()
      .includes(query)
  })
  return {
    command,
    catalog,
    rows,
    selected,
    setSelected(row: AutomationCommandCatalogRow | null) {
      command.view.advance()
      command.setBusy(false)
      setSelected(row)
    },
    executionType,
    createReady: resolution.status === 'ready' && resolution.entry.kind === 'self',
    createDestination: {
      ...controller.destination.createDestination.control,
      entries: controller.destination.createDestination.control.entries.filter(
        (entry) => entry.kind === 'self'
      )
    },
    select(row: AutomationCommandCatalogRow) {
      command.view.advance()
      command.setBusy(false)
      setSelected(row)
      setIsDetailOpen(true)
    },
    changeType(value: 'agent' | 'command') {
      setExecutionType(value)
      if (value === 'command') {
        setSelected(null)
        command.openCreate()
      } else {
        command.setEditorOpen(false)
      }
    },
    closeEditor() {
      command.view.advance()
      command.setEditorOpen(false)
      setExecutionType('agent')
      controller.local.setCreateOpen(false)
    },
    edit() {
      setExecutionType('command')
      command.openEdit()
    }
  }
}
