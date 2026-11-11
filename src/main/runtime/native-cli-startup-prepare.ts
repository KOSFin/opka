import { createHash } from 'node:crypto'
import type { NativeCliAccountLaunchV2Request } from '../../shared/native-cli-account-launch'
import {
  nativeCliControlErrorReply,
  NativeCliControlError
} from '../../shared/native-cli-control-error'
import type { OrcaRuntimeService } from './orca-runtime'
import { verifyProjectTaskTerminalProof } from './project-task-terminal-proof'
import { prepareNativeCliAccountLaunch } from './native-cli-account-launch'
import { isNativeCodexRoutingPty } from './native-codex-routing-ownership'
import { isNativeClaudeRoutingPty } from './native-claude-routing-ownership'
import { parsePaneKey } from '../../shared/stable-pane-id'

type Runtime = Pick<
  OrcaRuntimeService,
  | 'getOrchestrationDispatchAuthority'
  | 'resolveTerminalPane'
  | 'getNativeCliStartupForHandle'
  | 'getOrchestrationDb'
  | 'reportAgentLaunchPaneVerdict'
>

export function captureNativeCliStartup(runtime: Runtime, params: NativeCliAccountLaunchV2Request) {
  const proof = verifyProjectTaskTerminalProof(runtime, params.parentTerminal)
  const observed = proof && runtime.getOrchestrationDispatchAuthority(proof.terminalHandle)
  const authority = observed ? { ...observed } : null
  const startup = proof && runtime.getNativeCliStartupForHandle(proof.terminalHandle)
  const tokenHash = createHash('sha256').update(params.startup.launchToken).digest('hex')
  if (
    !proof ||
    !authority ||
    !startup ||
    startup.agent !== params.provider ||
    authority.hostScope.kind !== 'local' ||
    authority.processIncarnation !== proof.processIncarnation ||
    authority.launchTokenHash !== tokenHash
  ) {
    throw new NativeCliControlError('owner_changed')
  }
  const pane = runtime.resolveTerminalPane(proof.paneKey, authority.worktreeId)
  if (
    !pane.connected ||
    pane.executionHostId !== 'local' ||
    pane.handle !== authority.terminalHandle ||
    pane.ptyId !== authority.ptyId ||
    pane.incarnationId !== startup.incarnationId ||
    authority.processIncarnation !== `${authority.ptyId}:${startup.incarnationId}`
  ) {
    throw new NativeCliControlError('owner_changed')
  }
  const current = () => {
    const next = runtime.getOrchestrationDispatchAuthority(proof.terminalHandle)
    const nextProof = verifyProjectTaskTerminalProof(runtime, params.parentTerminal)
    let nextPane
    try {
      nextPane = runtime.resolveTerminalPane(proof.paneKey, authority.worktreeId)
    } catch {
      return false
    }
    return (
      nextPane.connected &&
      nextPane.executionHostId === 'local' &&
      nextPane.handle === authority.terminalHandle &&
      nextPane.ptyId === authority.ptyId &&
      nextPane.incarnationId === startup.incarnationId &&
      next &&
      nextProof &&
      runtime.getNativeCliStartupForHandle(proof.terminalHandle) === startup &&
      next.runtimeId === authority.runtimeId &&
      next.hostScope.kind === 'local' &&
      next.ptyId === authority.ptyId &&
      next.worktreeId === authority.worktreeId &&
      next.paneKey === authority.paneKey &&
      next.processIncarnation === authority.processIncarnation &&
      next.launchTokenHash === tokenHash &&
      nextProof.launchTokenHash === proof.launchTokenHash
    )
  }
  const unconsumed = () =>
    !isNativeCodexRoutingPty(runtime, authority.ptyId, startup.incarnationId) &&
    !isNativeClaudeRoutingPty(runtime, authority.ptyId, startup.incarnationId)
  return { startup, authority: { ...authority, paneKey: proof.paneKey }, current, unconsumed }
}

export async function prepareNativeCliStartup(
  runtime: OrcaRuntimeService,
  params: NativeCliAccountLaunchV2Request
) {
  const owner = captureNativeCliStartup(runtime, params)
  if (!owner.unconsumed()) {
    owner.startup.finish('prepared')
  }
  const { startup: _startup, ...request } = params
  if (!owner.startup.begin(params.launchId)) {
    if (owner.startup.state === 'prepared' && owner.startup.launchId !== params.launchId) {
      return prepareNativeCliAccountLaunch(runtime, request)
    }
    throw new NativeCliControlError('owner_changed')
  }
  try {
    const result = await prepareNativeCliAccountLaunch(runtime, request, {
      assertCurrent: () => {
        if (!owner.current()) {
          throw new NativeCliControlError('owner_changed')
        }
      }
    })
    if (!owner.current()) {
      throw new NativeCliControlError('owner_changed')
    }
    owner.startup.finish('prepared', params.launchId)
    return result
  } catch (error) {
    const known = nativeCliControlErrorReply(error)
    if (
      owner.current() &&
      owner.unconsumed() &&
      known &&
      error instanceof NativeCliControlError &&
      owner.startup.refuse(params.launchId, error)
    ) {
      // The host binding, never the caller's owner key, chooses the disposable reservation.
      runtime.getOrchestrationDb().releaseUnconsumedNativeCliStartup({
        provider: params.provider,
        ptyId: owner.authority.ptyId,
        incarnationId: owner.startup.incarnationId,
        assertCurrent: () => Boolean(owner.current() && owner.unconsumed())
      })
      runtime.noteNativeCliStartupRefusal(owner.authority.paneKey, known.message)
      const pane = parsePaneKey(owner.authority.paneKey)
      if (pane) {
        runtime.reportAgentLaunchPaneVerdict(
          { worktreeId: owner.authority.worktreeId, ...pane },
          { kind: 'not-started', code: known.code }
        )
      }
    } else if (owner.current()) {
      owner.startup.finish('unconfirmed', params.launchId)
    }
    throw error
  }
}
