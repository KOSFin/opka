import type {
  NativeClaudeRoutingOptions,
  NativeClaudeRoutingSelection as Selection
} from './native-claude-routing-contract'
import { claudeNativeAssignmentAdmission } from './claude-native-scoped-assignment'
import { readyNativeClaudePoolCandidates } from './native-claude-pool-candidates'

export type NativeClaudeSelectionLeaseOptions = Pick<
  NativeClaudeRoutingOptions,
  | 'launchId'
  | 'initialAccountId'
  | 'initialOwnerKey'
  | 'db'
  | 'sources'
  | 'acquireAssignment'
  | 'readCandidates'
  | 'readOwner'
  | 'readPolicy'
>

/** One launch owns its current lease and at most one unpublished replacement. */
export function createNativeClaudeSelectionLease(options: NativeClaudeSelectionLeaseOptions) {
  let accountId = options.initialAccountId,
    ownerKey = options.initialOwnerKey,
    pending: Selection | undefined,
    retiredOwnerKey: string | undefined,
    closed = false,
    ambiguous = false
  const assertOpen = () => {
    options.sources.assertOwned()
    if (closed) {
      throw new Error('Claude native account selection is unavailable.')
    }
  }
  const releaseRetired = () => {
    if (retiredOwnerKey) {
      options.sources.assertOwned()
      options.db.releaseAccountPoolAssignment(retiredOwnerKey)
      retiredOwnerKey = undefined
    }
  }
  const dropPending = () => {
    if (ambiguous) {
      throw new Error('Claude native account publication remains unverifiable.')
    }
    if (pending?.ownerKey && pending.ownerKey !== ownerKey) {
      options.sources.assertOwned()
      options.db.releaseAccountPoolAssignment(pending.ownerKey)
    }
    pending = undefined
  }
  const policy = () => {
    const value = options.readPolicy()
    return value?.provider === 'claude' ? value : undefined
  }
  const refresh = async (id: string, signal?: AbortSignal): Promise<Selection> => {
    const owner = options.readOwner()
    assertOpen()
    if (!owner) {
      throw new Error('Claude native account selection is unavailable.')
    }
    const access = await options.sources.refresh(id, signal)
    options.sources.assertAccountOwned(id)
    assertOpen()
    if (signal?.aborted || options.readOwner()?.identity !== owner.identity) {
      throw new Error('Claude native account selection changed.')
    }
    return { accountId: id, access }
  }
  return {
    get accountId() {
      return accountId
    },
    get ownerKey() {
      return ownerKey
    },
    get pending() {
      return pending
    },
    get closed() {
      return closed
    },
    get ambiguous() {
      return ambiguous
    },
    assertOpen,
    releaseRetired,
    dropPending,
    close: () => {
      closed = true
    },
    retainAmbiguous: () => {
      ambiguous = true
    },
    async refreshCurrent(signal?: AbortSignal) {
      const id = accountId,
        owner = ownerKey
      const selection = await refresh(id, signal)
      if (accountId !== id || ownerKey !== owner) {
        throw new Error('Claude native account selection changed.')
      }
      return { ...selection, ownerKey: owner }
    },
    async stageManual(id: string, signal?: AbortSignal) {
      assertOpen()
      if (ambiguous) {
        throw new Error('Claude native account publication remains unverifiable.')
      }
      dropPending()
      const selection = await refresh(id, signal)
      if (ambiguous) {
        throw new Error('Claude native account publication remains unverifiable.')
      }
      pending = selection
      return pending
    },
    async select(excluded: ReadonlySet<string>, signal?: AbortSignal): Promise<Selection> {
      assertOpen()
      if (ambiguous) {
        throw new Error('Claude native account publication remains unverifiable.')
      }
      releaseRetired()
      const ready = await options.sources.readyAccountIds()
      assertOpen()
      const saved = policy(),
        owner = options.readOwner()
      if (!saved || !owner || signal?.aborted) {
        throw new Error('Claude native account selection is unavailable.')
      }
      dropPending()
      const assignment = claudeNativeAssignmentAdmission(options)({
        replacesOwnerKey: ownerKey,
        policy: saved,
        candidates: readyNativeClaudePoolCandidates(options.readCandidates(), ready, excluded)
      })
      try {
        const selection = await refresh(assignment.accountId, signal)
        const currentPolicy = policy()
        if (
          currentPolicy?.id !== saved.id ||
          currentPolicy.revision !== saved.revision ||
          options.readOwner()?.identity !== owner.identity
        ) {
          throw new Error('Claude native account selection changed.')
        }
        pending = { ...selection, ownerKey: assignment.ownerKey }
        return pending
      } catch (error) {
        options.sources.assertOwned()
        options.db.releaseAccountPoolAssignment(assignment.ownerKey)
        throw error
      }
    },
    adopt(selection: Selection) {
      options.sources.assertAccountOwned(selection.accountId)
      if (closed || ambiguous || pending !== selection) {
        throw new Error('Claude native publication boundary changed.')
      }
      const previous = ownerKey
      ownerKey = selection.ownerKey
      accountId = selection.accountId
      pending = undefined
      if (previous && previous !== ownerKey) {
        retiredOwnerKey = previous
      }
    },
    releaseCurrentAssignment() {
      if (ownerKey) {
        retiredOwnerKey = ownerKey
        ownerKey = undefined
        releaseRetired()
      }
    },
    dispose(releaseCurrent: boolean) {
      closed = true
      if (ambiguous && !releaseCurrent) {
        return
      }
      ambiguous = false
      dropPending()
      releaseRetired()
      if (ownerKey && releaseCurrent) {
        options.sources.assertOwned()
        options.db.releaseAccountPoolAssignment(ownerKey)
      }
    }
  }
}
