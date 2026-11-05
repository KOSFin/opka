import { join } from 'node:path'
import { QUALIFIED_NATIVE_CLAUDE_VERSION } from '../../shared/native-claude-capability'
import { ClaudeHookService } from '../claude/hook-service'
import { readBoundedClaudeProfileSurface } from './claude-native-access'
import { writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { parseHooksJsonText } from '../agent-hooks/hooks-json-read'
import { removeManagedHooks, removeManagedStatusLine } from '../claude/hook-settings'

const configRecord = z.record(z.string(), z.unknown())
/** Own only these exact commands; native MCP, user hooks and settings remain native-owned. */
export function createClaudeNativePoolHookSettings(
  launchId: string,
  launch: { command: string; args: string[] },
  options: { nativeCoverage?: boolean } = {}
) {
  z.uuid().parse(launchId)
  if (!isAbsolute(launch.command)) {
    throw new Error('Claude pool hooks require the owning host CLI launcher.')
  }
  const command = (action: string, rewake = false) => ({
    type: 'command',
    command: launch.command,
    args: [...launch.args, 'agent', 'native-pool-hook', launchId, action],
    timeout: 50,
    ...(action === 'prompt' ? { onFailure: 'block' } : {}),
    ...(rewake ? { asyncRewake: true } : {})
  })
  const owned = (value: unknown) => {
    const hook = configRecord.safeParse(value)
    if (!hook.success || hook.data.type !== 'command' || hook.data.command !== launch.command) {
      return false
    }
    const args = z.array(z.string()).safeParse(hook.data.args)
    return (
      args.success &&
      args.data.length === launch.args.length + 4 &&
      launch.args.every((arg, index) => args.data[index] === arg) &&
      args.data[launch.args.length] === 'agent' &&
      args.data[launch.args.length + 1] === 'native-pool-hook' &&
      args.data[launch.args.length + 2] === launchId
    )
  }
  const remove = (settings: Record<string, unknown>) => {
    const parsed = configRecord.safeParse(settings.hooks)
    if (!parsed.success) {
      return settings
    }
    const hooks = Object.fromEntries(
      Object.entries(parsed.data).map(([event, groups]) => {
        if (!Array.isArray(groups)) {
          return [event, groups]
        }
        return [
          event,
          groups.flatMap((group) => {
            const parsed = configRecord.safeParse(group)
            if (!parsed.success || !Array.isArray(parsed.data.hooks)) {
              return [group]
            }
            const entries = parsed.data.hooks.filter((hook) => !owned(hook))
            return entries.length ? [{ ...parsed.data, hooks: entries }] : []
          })
        ]
      })
    )
    return { ...settings, hooks }
  }
  return {
    remove,
    apply: (settings: Record<string, unknown>) => {
      const clean = remove(settings),
        parsed = configRecord.safeParse(clean.hooks)
      if (clean.hooks !== undefined && !parsed.success) {
        throw new Error('Claude native hook configuration is unreadable.')
      }
      const hooks = { ...(parsed.success ? parsed.data : {}) }
      for (const [event, group] of Object.entries({
        UserPromptSubmit: { hooks: [command('prompt'), command('fresh-wake', true)] },
        ...(!options.nativeCoverage ? { Stop: { hooks: [command('stop')] } } : {}),
        StopFailure: { matcher: 'rate_limit', hooks: [command('failure', true)] }
      })) {
        const existing = hooks[event]
        if (existing !== undefined && !Array.isArray(existing)) {
          throw new Error('Claude native hook entries are unreadable.')
        }
        hooks[event] = [...(Array.isArray(existing) ? existing : []), group]
      }
      return { ...clean, hooks }
    }
  }
}

export function projectClaudeNativePoolPreferences(
  settings: Record<string, unknown>
): Record<string, unknown> {
  const parsed = parseHooksJsonText(JSON.stringify(settings))
  if (!parsed) {
    throw new Error('Claude native hook configuration is unreadable.')
  }
  return removeManagedStatusLine(removeManagedHooks(parsed).config).config
}

export function installClaudeNativePoolHooks(args: {
  home: string
  settings: ReturnType<typeof createClaudeNativePoolHookSettings>
  assertExclusive: () => void
}): void {
  args.assertExclusive()
  const installed = new ClaudeHookService().install({
    configDir: args.home,
    claudeVersion: QUALIFIED_NATIVE_CLAUDE_VERSION
  })
  if (installed.state !== 'installed') {
    throw new Error('Canonical Claude hooks could not be installed in the native facade.')
  }
  const path = join(args.home, 'settings.json'),
    before = readBoundedClaudeProfileSurface(path)
  if (before.value.disableAllHooks === true) {
    throw new Error('Enable native hooks before using automatic Claude routing.')
  }
  args.assertExclusive()
  if (
    !writeFileAtomicallyIfUnchanged(
      path,
      before.raw,
      JSON.stringify(args.settings.apply(before.value)),
      { mode: 0o600 }
    )
  ) {
    throw new Error('Claude native hook settings changed while preparing the launch.')
  }
}
