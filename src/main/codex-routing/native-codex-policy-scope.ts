import { lstat } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

const SYSTEM_INPUTS = [
  '/etc/codex/config.toml',
  '/etc/codex/managed_config.toml',
  '/etc/codex/requirements.toml'
] as const
const FORCED_POLICY_QUERY = `ObjC.import("CoreFoundation"); JSON.stringify({config:Boolean($.CFPreferencesAppValueIsForced($("config_toml_base64"),$("com.openai.codex"))),requirements:Boolean($.CFPreferencesAppValueIsForced($("requirements_toml_base64"),$("com.openai.codex")))})`
const ForcedPolicy = z.object({ config: z.boolean(), requirements: z.boolean() }).strict()

/** Managed policy can override even CLI auth/transport flags; never silently bypass it. */
export async function assertNativeCodexPolicyScope(
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error('Native Codex policy qualification is unavailable on this platform.')
  }
  for (const path of SYSTEM_INPUTS) {
    try {
      await lstat(path)
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        continue
      }
      throw new Error('System native Codex policy could not be verified.')
    }
    throw new Error(
      'System native Codex configuration requires review before host account routing.'
    )
  }
  if (platform !== 'darwin') {
    return
  }
  let forced: z.infer<typeof ForcedPolicy>
  try {
    const result = await runProcess({
      program: '/usr/bin/osascript',
      args: ['-l', 'JavaScript', '-e', FORCED_POLICY_QUERY],
      timeoutMs: 3000,
      maxOutputBytes: 1024,
      killOnOutputLimit: true
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error('unavailable')
    }
    forced = ForcedPolicy.parse(JSON.parse(result.stdout))
  } catch {
    throw new Error('Managed native Codex policy could not be verified on this Mac.')
  }
  if (forced.config || forced.requirements) {
    throw new Error('Managed native Codex policy requires review before host account routing.')
  }
}
