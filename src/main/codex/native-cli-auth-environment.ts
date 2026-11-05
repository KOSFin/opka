import { readNativeHomeInput } from '../codex-routing/codex-native-home-inputs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { z } from 'zod'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

const ProviderConfig = z.object({ model_provider: z.string().optional() }).passthrough()
const Config = ProviderConfig.extend({
  profile: z.string().optional(),
  profiles: z.record(z.string(), ProviderConfig).optional()
})

/** Custom provider credentials remain native; an OpenAI account must not inherit another login. */
export async function readNativeCodexModelProvider(
  home: string,
  profile?: string,
  providerOverride?: string,
  nativeVersion?: string
): Promise<string> {
  let contents = ''
  try {
    contents =
      nativeVersion === '0.166.0'
        ? ((await readNativeHomeInput(join(home, 'config.toml')))?.toString('utf8') ?? '')
        : await readFile(join(home, 'config.toml'), 'utf8')
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  const config = Config.parse(parse(contents))
  if (nativeVersion === '0.166.0') {
    if (config.profile || (profile && config.profiles?.[profile])) {
      throw new Error('Native Codex 0.166 requires separate named profile configuration files.')
    }
    if (profile && !/^[A-Za-z0-9_-]{1,128}$/.test(profile)) {
      throw new Error('The native Codex profile name is unavailable.')
    }
    const bytes = profile ? await readNativeHomeInput(join(home, `${profile}.config.toml`)) : null
    if (profile && !bytes) {
      throw new Error('The native Codex profile is unavailable.')
    }
    const selected = bytes ? ProviderConfig.parse(parse(bytes.toString('utf8'))) : undefined
    return providerOverride ?? selected?.model_provider ?? config.model_provider ?? 'openai'
  }
  const selectedProfile = profile ?? config.profile
  return (
    providerOverride ??
    (selectedProfile ? config.profiles?.[selectedProfile]?.model_provider : undefined) ??
    config.model_provider ??
    'openai'
  )
}

export async function nativeCodexAuthEnvToDelete(
  home: string,
  profile?: string,
  providerOverride?: string
): Promise<string[]> {
  return (await readNativeCodexModelProvider(home, profile, providerOverride)) === 'openai'
    ? ['OPENAI_API_KEY', 'CODEX_API_KEY']
    : []
}
