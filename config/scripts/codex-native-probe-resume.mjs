import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { spawnProcess } from '@orca/process-host'
import { parse } from 'smol-toml'
import { nativeProbeRoutingPlan } from './codex-native-probe-configuration.mjs'
import { nativeProbeManagedArguments } from './codex-native-probe-arguments.mjs'
import { createNativeCodexSessionAuthority } from '../../src/main/runtime/native-codex-session-authority.ts'
import {
  registerNativeCodexRoutingOwner,
  revokeNativeCodexRoutingLaunch,
  selectNativeCodexRoutingAccount
} from '../../src/main/runtime/native-codex-routing-ownership.ts'
import { redactTranscript } from './pty-transcript-secret-scan.mjs'

/** A new external native producer resumes the actual first producer's private rollout. */
export async function runNativeResumeProbe({
  binary,
  builtinOpenai = false,
  gateway,
  home,
  workspace,
  frontPort,
  sessions,
  runtime,
  threadId,
  env,
  output,
  report
}) {
  const launchId = randomUUID()
  let native, child
  const authority = createNativeCodexSessionAuthority(
    runtime,
    launchId,
    () => null,
    home,
    () => native?.readActiveRequests() === 0
  )
  const noPtyBoundary = { canSwitch: () => false, onBoundaryAccepted: () => {} }
  let boundRoot = null
  native = sessions.register({
    launchId,
    ownerPrefix: 'synthetic-native-resume',
    canSwitch: () => false,
    readBoundary: (next) => authority.boundary(noPtyBoundary, next),
    onRootThreadBound: (id, context) => {
      if (id !== threadId) {
        throw new Error('Resumed native ROOT mismatch')
      }
      boundRoot = id
      authority.bindRoot(id, context)
    },
    onRootTurnAccepted: authority.onRootTurnAccepted,
    areRetainedTurnsSettled: authority.areRetainedTurnsSettled,
    canReplaceRejectedRequest: authority.canReplaceRejectedRequest,
    prepareQuotaRetry: authority.prepareQuotaRetry,
    onAccountSelected: (binding) => selectNativeCodexRoutingAccount(runtime, launchId, binding)
  })
  registerNativeCodexRoutingOwner(runtime, launchId, {
    readOwner: () => null,
    revoke: native.revoke,
    dispose: authority.dispose,
    routingKey: native.apiKey
  })
  try {
    const plan = nativeProbeRoutingPlan(
      {
        baseUrl: `http://127.0.0.1:${frontPort}/v1`,
        apiKey: native.apiKey
      },
      builtinOpenai,
      gateway
    )
    const providerId = parse(plan.codexConfigOverrides.join('\n')).model_provider
    const childEnv = { ...env, ...plan.env, CODEX_HOME: home }
    for (const key of [
      'ORCA_PANE_KEY',
      'ORCA_TAB_ID',
      'ORCA_WORKTREE_ID',
      'ORCA_AGENT_LAUNCH_TOKEN'
    ]) {
      delete childEnv[key]
    }
    child = spawnProcess({
      program: binary,
      args: nativeProbeManagedArguments(
        [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '-C',
          workspace,
          '-s',
          'read-only',
          'resume',
          threadId,
          'Return SYNTHETIC_B_MARKER using the retained exchange.'
        ],
        plan
      ),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let text = '',
      size = 0
    const collect = (bytes) => {
      size += bytes.length
      if (size > 1024 * 1024) {
        child.kill('SIGKILL')
        return
      }
      text += bytes.toString()
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000)
    const [exitCode] = await once(child, 'close')
    clearTimeout(timer)
    await writeFile(output, redactTranscript(text).text, { mode: 0o600 })
    report.resume = {
      exitCode,
      providerId,
      boundRoot,
      bytes: size,
      ordinaryPty: false,
      ownedExternalSource: true
    }
    if (exitCode !== 0 || boundRoot !== threadId || size > 1024 * 1024) {
      throw new Error('Native resume process/configuration failed')
    }
    return { providerId }
  } finally {
    if (child?.exitCode === null) {
      child.kill('SIGKILL')
    }
    gateway?.revoke(native.apiKey)
    await revokeNativeCodexRoutingLaunch(runtime, launchId)
    authority.dispose()
  }
}
