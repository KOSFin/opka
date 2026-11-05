import { dirname } from 'node:path'
import { QUALIFIED_NATIVE_CLAUDE_VERSION } from '../../shared/native-claude-capability'
import { CLAUDE_AUTH_ENV_VARS } from '../../shared/claude-auth-environment'
import { reserveEngineWriter } from '../codex-routing/engine-writer-ownership'
import {
  AgentModelCatalogProbeError,
  runAgentModelCatalogListing
} from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import {
  readClaudeNativeAccessSnapshot,
  type ClaudeNativeIdentity,
  type ClaudeNativeAccessSnapshot
} from './claude-native-access'

const COOLDOWN_MS = 10 * 60_000
const MAX_PENDING = 128
let serial: Promise<void> = Promise.resolve()
let pending = 0
let writerUnverifiable = false
const inFlight = new Map<string, Promise<ClaudeNativeAccessSnapshot>>()
const lastAttempt = new Map<string, number>()

export type ClaudeNativeRefreshSource = {
  /** Host-local canonical profile identity; never a client-provided path. */
  configDir: string
  writerDirectory: string
  expectedIdentity: ClaudeNativeIdentity
  launch: Pick<ProviderProcessLaunch, 'command' | 'args' | 'cwd'>
  qualifiedVersion: string
  /** Must retain the host mutation lease and exclude all unpooled native writers. */
  assertExclusive: () => void
}
type RefreshOptions = {
  signal?: AbortSignal
  now?: () => number
  read?: typeof readClaudeNativeAccessSnapshot
  run?: typeof runAgentModelCatalogListing
  reserve?: typeof reserveEngineWriter
}

function fresh(
  snapshot: ClaudeNativeAccessSnapshot | null,
  now: number
): snapshot is ClaudeNativeAccessSnapshot {
  return Boolean(
    snapshot &&
    snapshot.access.expiresAt > now + 30_000 &&
    snapshot.access.scopes.includes('user:inference')
  )
}

export function supportsClaudeNativeRefreshVersion(version: string): boolean {
  return version === QUALIFIED_NATIVE_CLAUDE_VERSION
}

/** Native /usage is the only refresh writer; model traffic remains in the user's native CLI. */
export function refreshClaudeNativeAccess(
  source: ClaudeNativeRefreshSource,
  options: RefreshOptions = {}
): Promise<ClaudeNativeAccessSnapshot> {
  source.assertExclusive()
  if (!supportsClaudeNativeRefreshVersion(source.qualifiedVersion)) {
    return Promise.reject(new Error('Claude native refresh capability is not qualified.'))
  }
  const held = inFlight.get(source.configDir)
  if (held) {
    return held
  }
  if (pending >= MAX_PENDING || writerUnverifiable) {
    return Promise.reject(new Error('Claude native refresh authority is unavailable.'))
  }
  pending++
  const operation = serial.then(async () => {
    if (writerUnverifiable || options.signal?.aborted) {
      throw new Error('Claude native refresh authority is unavailable.')
    }
    source.assertExclusive()
    const now = options.now ?? Date.now
    const read = options.read ?? readClaudeNativeAccessSnapshot
    const previous = await read(source.configDir, source.expectedIdentity)
    const attempted = lastAttempt.get(source.configDir)
    if (fresh(previous, now()) && attempted !== undefined && now() - attempted < COOLDOWN_MS) {
      return previous
    }
    const owner = (options.reserve ?? reserveEngineWriter)({
      directory: source.writerDirectory,
      assertExclusive: source.assertExclusive
    })
    lastAttempt.delete(source.configDir)
    lastAttempt.set(source.configDir, now())
    if (lastAttempt.size > MAX_PENDING) {
      lastAttempt.delete(lastAttempt.keys().next().value ?? '')
    }
    let closed = false
    let phase = 'native-command'
    try {
      await (options.run ?? runAgentModelCatalogListing)(
        {
          ...source.launch,
          cwd: source.configDir,
          args: [
            ...source.launch.args,
            '-p',
            '/usage',
            '--output-format',
            'json',
            '--tools',
            '',
            '--strict-mcp-config',
            '--setting-sources',
            '',
            '--no-session-persistence',
            '--settings',
            '{"disableAllHooks":true,"autoMemoryEnabled":false}'
          ],
          env: {
            HOME: dirname(source.configDir),
            CLAUDE_CONFIG_DIR: source.configDir,
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            DISABLE_AUTOUPDATER: '1',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1'
          },
          envToDelete: [
            ...CLAUDE_AUTH_ENV_VARS,
            'ANTHROPIC_CUSTOM_HEADERS',
            'ANTHROPIC_BASE_URL',
            'CLAUDE_CODE_CUSTOM_OAUTH_URL',
            'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
            'CLAUDE_CODE_USE_BEDROCK',
            'CLAUDE_CODE_USE_VERTEX',
            'CLAUDE_CODE_USE_FOUNDRY'
          ]
        },
        {
          site: 'claude-native-refresh-authority',
          timeoutMs: 45_000,
          maxOutputBytes: 64 * 1024,
          signal: options.signal,
          onGroupProven: owner.recordGroup,
          onNotStarted() {
            try {
              owner.cancelBeforeSpawn()
              closed = true
            } catch {
              writerUnverifiable = true
            }
          },
          onClosed(result) {
            try {
              owner.release(result)
              closed = true
            } catch {
              writerUnverifiable = true
            }
          }
        }
      )
      phase = 'writer-close'
      if (!closed) {
        throw new Error('writer-unverifiable')
      }
      source.assertExclusive()
      phase = 'fresh-access-read'
      const updated = await read(source.configDir, source.expectedIdentity)
      if (!fresh(updated, now())) {
        throw new Error('access-unavailable')
      }
      return updated
    } catch (error) {
      if (!closed) {
        writerUnverifiable = true
      }
      const reason = error instanceof AgentModelCatalogProbeError ? error.reason : 'unavailable'
      throw new Error(
        `Claude native refresh did not produce fresh matching access credentials (${phase}/${reason}).`
      )
    }
  })
  serial = operation.then(
    () => {},
    () => {}
  )
  inFlight.set(source.configDir, operation)
  void operation
    .finally(() => {
      pending--
      inFlight.delete(source.configDir)
    })
    .catch(() => {})
  return operation
}
