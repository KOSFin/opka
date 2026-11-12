import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AutomationRun } from '../../../../shared/automations-types'
import { indexLatestAutomationRuns } from './automation-list-last-run'
import type { AutomationCommandDefinitionV1 } from '../../../../shared/automation-command-domain'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationHostTarget } from './automation-host-client'
import { getAutomationHostTargetKey } from './automation-host-client'
import {
  listCommandAutomationsForTarget,
  listCommandAutomationHistoryPageForTarget
} from './automation-command-host-client'

export type AutomationCommandCatalogRow = {
  key: string
  host: AutomationHostCatalogEntry
  target: AutomationHostTarget
  lastRun: AutomationRun | null
  definition: AutomationCommandDefinitionV1
}

export function useAutomationCommandCatalog(entries: readonly AutomationHostCatalogEntry[]) {
  const [rows, setRows] = useState<AutomationCommandCatalogRow[]>([])
  const [failures, setFailures] = useState<string[]>([])
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const hosts = useMemo(() => entries.filter((entry) => entry.kind === 'self'), [entries])
  useEffect(() => {
    let current = true
    setRows([])
    setFailures([])
    void Promise.all(
      hosts.map(async (host) => {
        const authority = host.stableRef.authority
        const target: AutomationHostTarget =
          authority.kind === 'runtime'
            ? { kind: 'environment', environmentId: authority.environmentId }
            : { kind: 'local' }
        try {
          const definitions = await listCommandAutomationsForTarget(target)
          let reportError: string | null = null
          const history = await listCommandAutomationHistoryPageForTarget(target).catch(
            (cause: unknown) => {
              reportError = `${host.label}: ${cause instanceof Error ? cause.message : 'Reports unavailable'}`
              return { runs: [], nextCursor: null }
            }
          )
          const latest = indexLatestAutomationRuns(history.runs)
          return {
            rows: definitions.map((definition) => ({
              key: `command:${getAutomationHostTargetKey(target)}:${definition.id}`,
              host,
              target,
              definition,
              lastRun: latest.get(definition.id) ?? null
            })),
            error: reportError
          }
        } catch (cause) {
          return {
            rows: [],
            error: `${host.label}: ${cause instanceof Error ? cause.message : 'Host unavailable'}`
          }
        }
      })
    ).then((results) => {
      if (!current) {
        return
      }
      setRows(results.flatMap((result) => result.rows))
      setFailures(results.flatMap((result) => (result.error ? [result.error] : [])))
    })
    return () => {
      current = false
    }
  }, [hosts, revision])
  return { rows, failures, refresh }
}
