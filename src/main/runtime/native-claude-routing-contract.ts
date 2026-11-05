import type { NativeClaudeQuotaFailureConfirmation } from './native-claude-failure-admission'
import type {
  ClaudeNativeAssignmentAdmission,
  ClaudeNativeAssignmentDatabase
} from './claude-native-scoped-assignment'
import type { AccountPoolCandidate, AccountPoolPolicy } from '../../shared/account-pool-policy'
import type { ClaudeNativeAccessSnapshot } from '../claude-accounts/claude-native-access'
import type { ClaudeNativeRefreshSources } from '../claude-accounts/claude-native-refresh-sources'
export type NativeClaudeRoutingBoundary = {
  canSwitch: () => boolean
  onBoundaryAccepted: () => void
}
export type NativeClaudeRoutingSelection = {
  ownerKey?: string
  accountId: string
  access: ClaudeNativeAccessSnapshot
}
export type NativeClaudeRoutingOptions = {
  launchId: string
  initialAccountId: string
  managedCoverage?: boolean
  acquireAssignment?: ClaudeNativeAssignmentAdmission
  initialOwnerKey?: string
  db: ClaudeNativeAssignmentDatabase
  sources: Pick<
    ClaudeNativeRefreshSources,
    'refresh' | 'assertOwned' | 'readyAccountIds' | 'assertAccountOwned'
  >
  facade: {
    publish: (access: ClaudeNativeAccessSnapshot, canSwitch: () => boolean) => Promise<void>
  }
  confirmQuotaFailure?: NativeClaudeQuotaFailureConfirmation
  readPolicy: () => AccountPoolPolicy | undefined
  readManualAccountId?: () => string | null
  onAccountSelected?: (selection: NativeClaudeRoutingSelection) => void
  readCandidates: () => AccountPoolCandidate[]
  readOwner: () => { identity: string; sessionId: string } | null
  readBoundary: () => NativeClaudeRoutingBoundary
  readIdleBoundary?: () => NativeClaudeRoutingBoundary
  readCompletedSuccessfully: () => boolean
}
