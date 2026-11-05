import { NATIVE_CODEX_ROUTING_KEY_ENV } from './native-cli-account-launch'
import { NATIVE_CLAUDE_ROUTING_KEY_ENV } from './native-claude-hook'
import { normalizeProxyBypassRules } from './network-proxy'

export function hasNativeClaudeGatewayEnvironment(env: NodeJS.ProcessEnv): boolean {
  if (!/^sk-ant-oat01-[a-f0-9]{64}$/.test(env[NATIVE_CLAUDE_ROUTING_KEY_ENV] ?? '')) {
    return false
  }
  const port = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(env.ANTHROPIC_BASE_URL ?? '')?.[1]
  return port !== undefined && Number(port) >= 1 && Number(port) <= 65535
}

export function applyNativeCliAccountEnvironment(
  inherited: NodeJS.ProcessEnv,
  plan: { env: Record<string, string>; envToDelete: readonly string[] },
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env = { ...inherited }
  const normalize = (key: string) => (platform === 'win32' ? key.toUpperCase() : key)
  const deleted = new Set(plan.envToDelete.map(normalize))
  for (const key of Object.keys(env)) {
    if (deleted.has(normalize(key))) {
      delete env[key]
    }
  }
  Object.assign(env, plan.env)
  const claudeGateway = hasNativeClaudeGatewayEnvironment(plan.env)
  if (plan.env[NATIVE_CODEX_ROUTING_KEY_ENV] || claudeGateway) {
    const bypass = normalizeProxyBypassRules(
      `127.0.0.1,localhost,::1,${env.NO_PROXY ?? ''},${env.no_proxy ?? ''}`
    ).replaceAll(';', ',')
    env.NO_PROXY = bypass
    env.no_proxy = bypass
  }
  return env
}
