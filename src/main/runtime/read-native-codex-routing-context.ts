import { assertNativeCodexPolicyScope } from '../codex-routing/native-codex-policy-scope'
import type { NativeCliAccountLaunchRequest } from '../../shared/native-cli-account-launch'
import { readCodexNativeHomeSource } from '../codex-routing/codex-native-home'
import { readNativeCodexModelProvider } from '../codex/native-cli-auth-environment'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import {
  requireNativeCodexHomeContext,
  qualifyNativeCodexExecutable
} from './native-codex-home-context'

export async function readNativeCodexRoutingContext(
  runtime: object,
  params: NativeCliAccountLaunchRequest
) {
  const context = requireNativeCodexHomeContext(runtime)
  context.assertExclusive()
  await assertNativeCodexPolicyScope()
  const { nativeVersion, executable } = await qualifyNativeCodexExecutable(
    params.codexExecutable,
    context
  )
  const selectedSourceHome = context.resolveSourceHome() ?? getSystemCodexHomePath()
  const sourceHome = (await readCodexNativeHomeSource(context)) ?? selectedSourceHome
  const provider = await readNativeCodexModelProvider(
    sourceHome,
    params.codexProfile,
    params.codexModelProvider,
    nativeVersion
  )
  return provider === 'openai'
    ? { context, nativeVersion, executable, sourceHome, selectedSourceHome }
    : null
}
export type NativeCodexRoutingContext = NonNullable<
  Awaited<ReturnType<typeof readNativeCodexRoutingContext>>
>
