import { isDeepStrictEqual } from 'node:util'
import { removeHookTrustContent } from '../codex/config-toml-hook-trust-edit'
import { parse } from 'smol-toml'
import { isPlainObject } from '../agent-hooks/hooks-json-read'
import type { NativeUserFile } from '../cli/native-cli-user-installation-files'
import { readHooksJson } from '../agent-hooks/installer-utils'
import { getInPlaceCodexHookHome } from '../codex/codex-hook-orca-approvals'
import { computeTrustKey } from '../codex/config-toml-trust'
import {
  CODEX_EVENT_LABEL,
  getCodexManagedHookInstallMaterial
} from '../codex/codex-hook-definition'

export function readManagedNativeTrustKeys(homePath: string): Set<string> {
  const home = getInPlaceCodexHookHome(homePath)
  const hooks = readHooksJson(home.hooksJsonPath)?.hooks
  const keys = new Set<string>()
  if (!hooks) {
    return keys
  }
  const material = getCodexManagedHookInstallMaterial()
  for (const event of material.events) {
    for (const [groupIndex, group] of (hooks?.[event] ?? []).entries()) {
      for (const [handlerIndex, hook] of (group.hooks ?? []).entries()) {
        if (hook.command !== material.command) {
          continue
        }
        for (const sourcePath of home.keySourcePaths) {
          keys.add(
            computeTrustKey({
              sourcePath,
              eventLabel: CODEX_EVENT_LABEL[event],
              groupIndex,
              handlerIndex,
              command: material.command
            })
          )
        }
      }
    }
  }
  return keys
}

function withoutManagedTrust(bytes: Buffer, keys: ReadonlySet<string>): unknown {
  const raw = bytes.toString('utf8')
  const config = parse(raw)
  const hooks = config.hooks
  const removable: string[] = []
  let emptyState = false
  let emptyHooks = false
  if (isPlainObject(hooks) && isPlainObject(hooks.state)) {
    for (const key of keys) {
      const entry = hooks.state[key]
      if (
        isPlainObject(entry) &&
        Object.keys(entry).every((name) => ['enabled', 'trusted_hash'].includes(name))
      ) {
        delete hooks.state[key]
        removable.push(key)
      }
    }
    if (!Object.keys(hooks.state).length) {
      delete hooks.state
      emptyState = true
    }
    if (!Object.keys(hooks).length) {
      delete config.hooks
      emptyHooks = true
    }
  }
  let text = removeHookTrustContent(raw, removable)
  if (emptyState) {
    text = text.replace(/^\[hooks\.state\][ \t]*\r?\n/gm, '')
  }
  if (emptyHooks) {
    text = text.replace(/^\[hooks\][ \t]*\r?\n/gm, '')
  }
  return { config, text: text.trimEnd() }
}

/** Managed approvals do not turn unrelated user edits into an owned publication. */
export function managedNativeConfigHash(
  before: Pick<NativeUserFile, 'bytes' | 'sha256'>,
  after: Pick<NativeUserFile, 'bytes' | 'sha256'>,
  publishedHash: string,
  keys: ReadonlySet<string>
): string {
  if (before.sha256 !== publishedHash) {
    return publishedHash
  }
  return isDeepStrictEqual(
    withoutManagedTrust(before.bytes, keys),
    withoutManagedTrust(after.bytes, keys)
  )
    ? after.sha256
    : publishedHash
}
