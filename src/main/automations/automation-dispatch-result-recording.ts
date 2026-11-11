import type { Store } from '../persistence'
import {
  isFinalAutomationRunStatus,
  type AutomationDispatchResult,
  type AutomationRun
} from '../../shared/automations-types'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import { clearAutomationDispatchTokens } from './dispatch-tokens'
import { writeAutomationRunUsage } from './run-usage-collection'
import type { AutomationRunCompletionWatcher } from './run-completion-watcher'
import type { AutomationRunWriter } from './automation-run-writer'

export async function recordAutomationDispatchResult(input: {
  result: AutomationDispatchResult
  store: Store
  runs: AutomationRunWriter
  watcher: AutomationRunCompletionWatcher | null
  claudeUsage: ClaudeUsageStore | null
  codexUsage: CodexUsageStore | null
}): Promise<AutomationRun> {
  const run = await input.runs.updateRun(input.result)
  clearAutomationDispatchTokens(run.automationId, run.id)
  if (!isFinalAutomationRunStatus(run.status)) {
    if (run.status === 'dispatched') {
      input.watcher?.watch(run)
    }
    return run
  }
  input.watcher?.forget(run.id)
  // A repeated completion must not rewrite already-attributed usage.
  if (run.usage) {
    return run
  }
  return writeAutomationRunUsage({
    store: input.store,
    runs: input.runs,
    run,
    claudeUsage: input.claudeUsage,
    codexUsage: input.codexUsage
  })
}
