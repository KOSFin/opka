import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  writeFileAtomicallyIfUnchanged,
  recoverInterruptedGuardedFileOperation
} from '../codex-accounts/fs-utils'
import {
  ClaudeNativeIdentity,
  readBoundedClaudeProfileJson,
  readBoundedClaudeProfileSurface,
  type ClaudeNativeAccessSnapshot
} from './claude-native-access'

const Access = z
  .object({
    accessToken: z.string().min(1).max(32768),
    expiresAt: z.number().finite().positive(),
    scopes: z.array(z.string().max(256)).max(64),
    subscriptionType: z.string().max(256).optional(),
    rateLimitTier: z.string().max(256).optional()
  })
  .strict()
const Credentials = z.object({ claudeAiOauth: Access }).strict()
const Pair = z.object({ access: Access, identity: ClaudeNativeIdentity }).strict()
const Pending = z.object({ version: z.literal(1), from: Pair, to: Pair }).strict()
const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)
const drift = (): never => {
  throw new Error(
    'Claude native profile changed authentication; automatic account switching is suspended.'
  )
}

function compareWrite(file: string, expected: string | null, value: unknown): void {
  if (!writeFileAtomicallyIfUnchanged(file, expected, JSON.stringify(value), { mode: 0o600 })) {
    drift()
  }
}

/** Caller holds the host-owned facade lease; pending pairs contain access tokens only. */
export function createClaudeNativeFacadePublication(
  home: string,
  initial: ClaudeNativeAccessSnapshot
) {
  const credentialPath = join(home, '.credentials.json')
  const statePath = join(home, '.claude.json')
  const pendingPath = join(home, '.opka-access-pending.json')
  for (const file of [credentialPath, statePath, pendingPath]) {
    recoverInterruptedGuardedFileOperation(file)
  }
  let current = Pair.parse(initial)
  let suspended = false
  const readCredentials = () => Credentials.parse(readBoundedClaudeProfileJson(credentialPath))
  const readState = () => readBoundedClaudeProfileJson(statePath)
  const assertPair = (pair: ClaudeNativeAccessSnapshot) => {
    if (suspended) {
      drift()
    }
    if (
      !equal(readCredentials().claudeAiOauth, pair.access) ||
      !equal(ClaudeNativeIdentity.parse(readState().oauthAccount), pair.identity)
    ) {
      drift()
    }
  }
  const recover = () => {
    if (!existsSync(pendingPath)) {
      return
    }
    const pending = Pending.parse(readBoundedClaudeProfileJson(pendingPath))
    const credentialSurface = readBoundedClaudeProfileSurface(credentialPath)
    const stateSurface = readBoundedClaudeProfileSurface(statePath)
    const credentials = Credentials.parse(credentialSurface.value)
    const state = stateSurface.value
    const identity = ClaudeNativeIdentity.parse(state.oauthAccount)
    if (
      (!equal(credentials.claudeAiOauth, pending.from.access) &&
        !equal(credentials.claudeAiOauth, pending.to.access)) ||
      (!equal(identity, pending.from.identity) && !equal(identity, pending.to.identity))
    ) {
      drift()
    }
    compareWrite(credentialPath, credentialSurface.raw, { claudeAiOauth: pending.to.access })
    compareWrite(statePath, stateSurface.raw, { ...state, oauthAccount: pending.to.identity })
    current = pending.to
    rmSync(pendingPath)
  }
  return {
    initialize(): void {
      if (existsSync(credentialPath)) {
        recover()
        assertPair(current)
        return
      }
      const state = readBoundedClaudeProfileSurface(statePath)
      compareWrite(statePath, state.raw, { ...state.value, oauthAccount: current.identity })
      compareWrite(credentialPath, null, { claudeAiOauth: current.access })
    },
    /** Synchronous publication at a canonical main-turn boundary, never a cross-file transaction. */
    publish(next: ClaudeNativeAccessSnapshot, canSwitch: () => boolean): void {
      try {
        if (!canSwitch()) {
          throw new Error('Claude native account switch requires a completed main turn.')
        }
        recover()
        assertPair(current)
        const desired = Pair.parse(next)
        compareWrite(pendingPath, null, { version: 1, from: current, to: desired })
        recover()
        assertPair(current)
      } catch {
        suspended = true
        drift()
      }
    },
    recover(): void {
      try {
        recover()
        assertPair(current)
      } catch {
        suspended = true
        drift()
      }
    },
    assertUnchanged(): void {
      try {
        assertPair(current)
      } catch {
        suspended = true
        drift()
      }
    }
  }
}
