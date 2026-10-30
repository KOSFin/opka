import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { WorkerStartInput } from './worker-start-schema'
import type { AccountPoolAdmission } from '../../../../orchestration/account-pool-admission'
import { accountPoolCandidates } from '../../../../account-pool-candidates'
import {
  getAccountPoolPolicy,
  getDefaultAccountPool
} from '../../../../runtime-account-pool-policy'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export function prepareWorkerPoolAdmission(
  runtime: OrcaRuntimeService,
  params: WorkerStartInput
): AccountPoolAdmission | undefined {
  if (params.accountId || (params.agent !== 'claude' && params.agent !== 'codex')) {
    return undefined
  }
  const policy = params.accountPoolId
    ? getAccountPoolPolicy(runtime, params.accountPoolId)
    : getDefaultAccountPool(runtime, params.agent)
  if (!policy || (!params.accountPoolId && policy.strategy === 'manual')) {
    return undefined
  }
  if (params.on || params.terminal || (params.agent !== 'claude' && params.agent !== 'codex')) {
    throw new OrchestrationError(
      'account_pool_unsupported',
      'Pools require a new Claude or Codex worker on the owning execution host.',
      { effectsApplied: false }
    )
  }
  if (policy.provider !== params.agent) {
    throw new Error('The pool provider does not match this worker')
  }
  const candidates = accountPoolCandidates(runtime.getAccountsSnapshot()).filter(
    (entry) => entry.provider === policy.provider
  )
  for (const candidate of candidates) {
    if (policy.provider === 'codex' && candidate.auth === 'ready') {
      try {
        runtime.getWorkerCodexAccountEnv(candidate.accountId)
      } catch {
        candidate.auth = 'unavailable'
      }
    }
  }
  return { policy, candidates }
}

export function fixedWorkerPoolParams(
  startOptions: string,
  params: WorkerStartInput
): WorkerStartInput {
  const fixed = z.object({ account: z.object({ id: z.string() }) }).parse(JSON.parse(startOptions))
  return { ...params, accountId: fixed.account.id }
}
