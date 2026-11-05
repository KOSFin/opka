import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  writeFileAtomicallyIfUnchanged,
  recoverInterruptedGuardedFileOperation
} from '../codex-accounts/fs-utils'
import { readBoundedClaudeProfileSurface } from './claude-native-access'
import { assertClaudeProfileDescendant } from './claude-profile-paths'
import { claudeProfilePreferenceState } from './claude-profile-provisioning'

const record = z.record(z.string(), z.json())
const Preferences = z.object({ version: z.literal(1), settings: record, state: record }).strict()
type Preferences = z.infer<typeof Preferences>
const preferenceState = (value: Record<string, unknown>) => {
  const { numStartups: _nativeCounter, ...preferences } = claudeProfilePreferenceState(value)
  return preferences
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function mergeRecord(
  base: Record<string, unknown>,
  own: Record<string, unknown>,
  current: Record<string, unknown>
) {
  const merged = { ...current }
  let conflict = false
  for (const key of new Set([...Object.keys(base), ...Object.keys(own)])) {
    if (equal(base[key], own[key])) {
      continue
    }
    if (!equal(base[key], current[key]) && !equal(own[key], current[key])) {
      conflict = true
      continue
    }
    if (Object.hasOwn(own, key)) {
      merged[key] = own[key]
    } else {
      delete merged[key]
    }
  }
  return { merged, conflict }
}

/** A private profile-scoped master preserves native edits without changing the user's global home. */
export function openClaudeNativePreferences(args: {
  dataRoot: string
  home: string
  assertExclusive: () => void
  projectSettings: (settings: Record<string, unknown>) => Record<string, unknown>
}) {
  args.assertExclusive()
  const root = join(args.dataRoot, 'native-cli-preferences', 'claude')
  assertClaudeProfileDescendant(args.dataRoot, root)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, 'preferences.json'),
    conflictPath = join(root, 'conflict.json')
  for (const file of [path, conflictPath]) {
    recoverInterruptedGuardedFileOperation(file)
  }
  if (existsSync(conflictPath)) {
    throw new Error('Claude native preferences have a retained conflict requiring review.')
  }
  const settingsPath = join(args.home, 'settings.json'),
    statePath = join(args.home, '.claude.json')
  const readOwn = () =>
    Preferences.parse({
      version: 1,
      settings: args.projectSettings(readBoundedClaudeProfileSurface(settingsPath).value),
      state: preferenceState(readBoundedClaudeProfileSurface(statePath).value)
    })
  if (!existsSync(path)) {
    const seeded = JSON.stringify(readOwn())
    if (
      Buffer.byteLength(seeded) > 1024 * 1024 ||
      !writeFileAtomicallyIfUnchanged(path, null, seeded, { mode: 0o600 })
    ) {
      throw new Error('Claude native preferences initialization changed.')
    }
  }
  const initial = readBoundedClaudeProfileSurface(path)
  const validate = (value: unknown) => {
    const parsed = Preferences.parse(value)
    if (
      !equal(parsed.settings, args.projectSettings(parsed.settings)) ||
      !equal(parsed.state, preferenceState(parsed.state))
    ) {
      throw new Error('Claude native preferences contain account-bound state.')
    }
    return parsed
  }
  const base = validate(initial.value)
  const apply = (target: string, values: Record<string, unknown>, isState = false) => {
    args.assertExclusive()
    const before = readBoundedClaudeProfileSurface(target)
    const retained = isState
      ? Object.fromEntries(
          Object.entries(before.value).filter(
            ([key]) => !Object.hasOwn(preferenceState({ [key]: before.value[key] }), key)
          )
        )
      : {}
    if (
      !writeFileAtomicallyIfUnchanged(
        target,
        before.raw,
        JSON.stringify({ ...values, ...retained }),
        { mode: 0o600 }
      )
    ) {
      throw new Error('Claude native preferences changed while preparing the profile.')
    }
  }
  apply(settingsPath, base.settings)
  apply(statePath, base.state, true)
  let saved = false
  return {
    save: () => {
      args.assertExclusive()
      if (saved) {
        return
      }
      const own = readOwn(),
        current = readBoundedClaudeProfileSurface(path),
        latest = validate(current.value)
      const settings = mergeRecord(base.settings, own.settings, latest.settings),
        state = mergeRecord(base.state, own.state, latest.state)
      if (settings.conflict || state.conflict) {
        const retained = JSON.stringify(own)
        if (
          Buffer.byteLength(retained) > 1024 * 1024 ||
          !writeFileAtomicallyIfUnchanged(conflictPath, null, retained, { mode: 0o600 })
        ) {
          throw new Error('Claude native preferences conflict could not be retained safely.')
        }
        throw new Error(
          'Claude native preference edits conflict; the session and one private recovery slot are retained.'
        )
      }
      const merged = JSON.stringify({ version: 1, settings: settings.merged, state: state.merged })
      if (
        Buffer.byteLength(merged) > 1024 * 1024 ||
        !writeFileAtomicallyIfUnchanged(path, current.raw, merged, { mode: 0o600 })
      ) {
        throw new Error('Claude native preferences changed concurrently; session retained.')
      }
      saved = true
    }
  }
}
