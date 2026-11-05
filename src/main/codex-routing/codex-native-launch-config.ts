import type { NativeCliAccountLaunch } from '../../shared/native-cli-account-launch'
import { NATIVE_CODEX_ROUTING_KEY_ENV } from '../../shared/native-cli-account-launch'

export const CODEX_ROUTING_KEY_ENV = NATIVE_CODEX_ROUTING_KEY_ENV

/** The owned HOME carries only the local gateway key; provider credentials stay in the host. */
export function codexNativeRoutingLaunch(transport: {
  baseUrl: string
  apiKey: string
}): Pick<NativeCliAccountLaunch, 'env' | 'codexConfigOverrides'> {
  let url: URL
  try {
    url = new URL(transport.baseUrl)
  } catch {
    throw new Error('Native Codex requires an authenticated execution-host loopback transport')
  }
  const path = /^\/native\/([A-Za-z0-9._-]{32,512})\/v1$/.exec(url.pathname)
  const nonce = path?.[1]
  if (
    url.href !== transport.baseUrl ||
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    !nonce ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    transport.apiKey.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(transport.apiKey) ||
    nonce === transport.apiKey
  ) {
    throw new Error('Native Codex requires an authenticated execution-host loopback transport')
  }
  // Native resume validates the saved provider identity; built-in route/auth fields ignore table overrides.
  return {
    env: { [CODEX_ROUTING_KEY_ENV]: nonce },
    codexConfigOverrides: [
      'model_provider="openai"',
      `openai_base_url=${JSON.stringify(url.href)}`,
      'cli_auth_credentials_store="file"',
      'features.responses_websockets=false',
      'features.responses_websockets_v2=false',
      'features.api_key_model_discovery=false'
    ]
  }
}
