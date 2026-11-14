import { nativeCodexGatewayLaunch } from '../../src/main/codex-routing/codex-native-http-authentication.ts'
import { readOrCreateNativeCodexGatewayCredential } from '../../src/main/codex-routing/native-codex-gateway-credential.ts'

/** Uses the production credential and nonce projection; the production front authenticates requests. */
export function createNativeProbeGateway(report, directory) {
  const apiKey = readOrCreateNativeCodexGatewayCredential(directory, () => {})
  const retained = []
  const evidence = {
    durableLocalKey: true,
    providerCredentials: false,
    productionNativeAuthentication: true,
    retiredRejected: false
  }
  report.localGateway = evidence
  return {
    apiKey,
    register(capability, baseUrl) {
      if (retained.length >= 64) {
        throw new Error('Synthetic gateway fixture limit')
      }
      const result = nativeCodexGatewayLaunch(baseUrl, apiKey, { apiKey: capability })
      retained.push({ nonce: capability, base: result.baseUrl, retired: false })
      return result.baseUrl
    },
    revoke(capability) {
      for (const route of retained) {
        if (route.nonce === capability) {
          route.retired = true
        }
      }
    },
    async assertRetiredRejected(capability) {
      const route = retained.find((entry) => entry.nonce === capability)
      if (!route?.retired) {
        throw new Error('Synthetic old nonce not retired')
      }
      const response = await fetch(`${route.base}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-6.1-sol', input: [] }),
        signal: AbortSignal.timeout(2000)
      })
      const refusal = await response.text()
      evidence.retiredRejected = response.status === 502
      if (!evidence.retiredRejected) {
        throw new Error(
          `Retired nonce did not reach closed production session refusal: HTTP ${response.status}; ${refusal.slice(0, 256)}`
        )
      }
    },
    scrub(text) {
      let value = text
      for (const route of retained) {
        value = value.replaceAll(route.nonce, '<native-launch>')
      }
      return value.replaceAll(apiKey, '<local-gateway-key>')
    }
  }
}
