import { describe, expect, it } from 'vitest'
import {
  missingCommandDefinitionReport,
  missingCommandRunReport,
  selectCommandDefinitionId,
  selectCommandReportRunId,
  visibleCommandReportRun
} from './automation-command-report-selection'

describe('linked automation report selection', () => {
  it('leaves selection empty when a linked automation vanished but other definitions remain', () => {
    const definitions = [{ id: 'unrelated' }]
    const link = { automationId: 'removed', runId: 'run-removed' }

    expect(selectCommandDefinitionId(definitions, null, link)).toBeNull()
    expect(missingCommandDefinitionReport(definitions, link)).toBe(
      'The linked automation report is unavailable on this host.'
    )
    expect(selectCommandDefinitionId(definitions, null, null)).toBe('unrelated')
  })

  it('leaves the report empty when its run vanished but other runs remain', () => {
    const runs = [{ id: 'unrelated-run' }]

    expect(selectCommandReportRunId(runs, null, 'removed-run')).toBeNull()
    expect(
      visibleCommandReportRun(runs, null, 'automation-1', {
        automationId: 'automation-1',
        runId: 'removed-run'
      })
    ).toBeNull()
    expect(missingCommandRunReport(runs, 'removed-run')).toBe(
      'The linked report is unavailable on this host.'
    )
    expect(visibleCommandReportRun(runs, 'unrelated-run', 'automation-1', null)).toEqual(runs[0])
    expect(selectCommandReportRunId(runs, 'unrelated-run', null)).toBe('unrelated-run')
  })
})
