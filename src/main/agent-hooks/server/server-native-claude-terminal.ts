import { NativeClaudeCanonicalHookSchema } from '../../../shared/native-claude-canonical-hook'
import { ORCA_HOOK_PROTOCOL_VERSION } from '../../../shared/agent-hook-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  foldNativeClaudeCanonicalHook,
  nativeClaudeCanonicalPayload,
  recordNativeClaudeCanonicalReceipt
} from './native-claude-canonical-fold'
import { AgentHookServerNativeClaudeStructured } from './server-native-claude-structured'

export type NativeClaudeTerminalContext = {
  paneKey: string
  tabId: string
  worktreeId?: string
  ptyId: string
  incarnationId: string
  executionHostId: 'local'
  terminalHandle: string
}

/** The owning runtime resolves this context from its actual pane; no client supplies it. */
export abstract class AgentHookServerNativeClaudeTerminal extends AgentHookServerNativeClaudeStructured {
  ingestNativeClaudeTerminalHook(context: NativeClaudeTerminalContext, raw: unknown): boolean {
    const parsed = NativeClaudeCanonicalHookSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.nativeOrigin !== 'engine' ||
      !context.ptyId ||
      !context.incarnationId ||
      context.executionHostId !== 'local' ||
      parsePaneKey(context.paneKey)?.tabId !== context.tabId
    ) {
      return false
    }
    if (!this.statusHooksEnabled) {
      return !!foldNativeClaudeCanonicalHook(this.state, context.paneKey, parsed.data)
    }
    const hook = parsed.data,
      payload = nativeClaudeCanonicalPayload(hook)
    const normalized = this.normalizeLocalHookPayload('claude', {
      paneKey: context.paneKey,
      tabId: context.tabId,
      worktreeId: context.worktreeId,
      env: this.env,
      version: ORCA_HOOK_PROTOCOL_VERSION,
      launchToken: this.state.lastStatusByPaneKey.get(context.paneKey)?.launchToken,
      payload: { ...payload, hook_event_name: hook.event }
    })
    const event = normalized.event
    if (!event || event.paneKey !== context.paneKey) {
      return false
    }
    const disposition = this.getAgentStatusDisposition(context.paneKey, {
      source: 'claude',
      hookEventName: event.hookEventName,
      hasExplicitPrompt: false,
      launchToken: event.launchToken
    })
    if (disposition === 'suppress') {
      return false
    }
    if (disposition === 'restart') {
      this.observations.rebind(context.paneKey)
    }
    event.terminalHandle = context.terminalHandle
    this.recordCurrentAuthorityObservation(event)
    this.applyNormalizedStatus(event, normalized.onAccepted)
    recordNativeClaudeCanonicalReceipt(this.state, context.paneKey, hook, payload)
    return true
  }
}
