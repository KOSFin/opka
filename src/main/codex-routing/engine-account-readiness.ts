import type { CodexPoolSelectionState } from './codex-pool-turn-session'
import type { EngineGrantAccount } from './engine-grant-files'

export function readyCodexPoolSelection(
  state: CodexPoolSelectionState,
  isReady: (accountId: string) => boolean
): CodexPoolSelectionState {
  return {
    ...state,
    candidates: state.candidates.map((candidate) => ({
      ...candidate,
      auth: candidate.auth === 'ready' && isReady(candidate.accountId) ? 'ready' : 'unavailable'
    }))
  }
}

export function assertExpectedEngineAccount(
  expected: EngineGrantAccount,
  current: EngineGrantAccount | null
): void {
  if (
    !current ||
    current.providerAccountId !== expected.providerAccountId ||
    current.rosterRevision !== expected.rosterRevision
  ) {
    throw new Error('The selected account changed during activation.')
  }
}
