import { claudeNativeSourceEnvironment } from './claude-native-source-environment'
import { CLAUDE_MANAGED_OAUTH_ENV_VARS } from '../../shared/claude-auth-environment'
import { reserveEngineWriter } from '../codex-routing/engine-writer-ownership'
import { runAgentModelCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { isClaudeManualSignInLink, prepareClaudeSignInBrowser } from './claude-sign-in-browser'

export type ClaudeNativeCodeWriter = (code: string) => Promise<void>

/** OAuth code redemption and refresh credentials stay inside the unmodified native login. */
export async function runClaudeNativeSourceLogin(options: {
  home: string
  nativeUserHome?: string
  writerDirectory: string
  launch: Pick<ProviderProcessLaunch, 'command' | 'args'>
  assertExclusive: () => void
  signal?: AbortSignal
  onLink?: (authorizationUrl: string) => void
  onCodeReady?: (submit: ClaudeNativeCodeWriter | null) => void
}): Promise<void> {
  const sourceEnvironment = claudeNativeSourceEnvironment(options.home, options.nativeUserHome)
  const owner = reserveEngineWriter({
    directory: options.writerDirectory,
    assertExclusive: options.assertExclusive
  })
  let closed = false
  let started = false
  let active = true
  let groupProven = false
  let submitted = false
  let childWrite: ClaudeNativeCodeWriter | undefined
  let observedLink: string | undefined
  let announced = false
  const announce = () => {
    if (!announced && active && groupProven && observedLink && childWrite) {
      options.assertExclusive()
      announced = true
      options.onLink?.(observedLink)
      options.onCodeReady?.(async (code) => {
        if (
          submitted ||
          !active ||
          options.signal?.aborted ||
          !childWrite ||
          !code.trim() ||
          code.length > 4096 ||
          !/^[^\s#\0]+#[^\s#\0]+$/.test(code.trim())
        ) {
          throw new Error('Claude native authorization code admission is unavailable.')
        }
        options.assertExclusive()
        submitted = true
        await childWrite(`${code.trim()}\n`)
      })
    }
  }
  const browser = await prepareClaudeSignInBrowser({
    windowsPath: options.home,
    linuxPath: null,
    wslDistro: null
  }).catch(() => {
    owner.cancelBeforeSpawn()
    throw new Error('Claude native source browser isolation is unavailable.')
  })
  try {
    let output = ''
    options.assertExclusive()
    if (options.signal?.aborted) {
      throw new Error('Native source sign-in stopped before spawning.')
    }
    started = true
    await runAgentModelCatalogListing(
      {
        ...options.launch,
        args: [
          ...options.launch.args,
          '--setting-sources',
          '',
          '--settings',
          '{"disableAllHooks":true}',
          'auth',
          'login',
          '--claudeai'
        ],
        cwd: options.home,
        env: {
          ...sourceEnvironment,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          DISABLE_AUTOUPDATER: '1',
          BROWSER: browser.path,
          NO_COLOR: '1'
        },
        envToDelete: [...CLAUDE_MANAGED_OAUTH_ENV_VARS],
        keepStdinOpen: true
      },
      {
        site: 'claude-native-source-login',
        signal: options.signal,
        timeoutMs: 600_000,
        maxOutputBytes: 64 * 1024,
        onGroupProven(group) {
          owner.recordGroup(group)
          groupProven = true
          announce()
        },
        onStdinReady(write) {
          childWrite = write
          announce()
        },
        onStdout(chunk) {
          output = (output + chunk).slice(-32768)
          for (const match of output.matchAll(/https:\/\/[^\s<>"']+/g)) {
            if (isClaudeManualSignInLink(match[0])) {
              observedLink = match[0]
              announce()
              break
            }
          }
        },
        onNotStarted() {
          owner.cancelBeforeSpawn()
          closed = true
        },
        onClosed(result) {
          owner.release(result)
          closed = true
        }
      }
    )
    if (!closed) {
      throw new Error('unverifiable-source-writer')
    }
  } catch {
    if (!started) {
      owner.cancelBeforeSpawn()
    }
    throw new Error('Claude native source sign-in did not complete with proven writer exit.')
  } finally {
    active = false
    options.onCodeReady?.(null)
    await browser.dispose()
  }
}
