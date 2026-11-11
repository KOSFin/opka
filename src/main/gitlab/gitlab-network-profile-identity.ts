import { normalizeGitLabNetworkUser } from '../../shared/gitlab-network-profile'
import { normalizeGitHttpsHost } from '../../shared/git-https-host'

const MAX_USER_RESPONSE_BYTES = 4096

export async function verifyGitLabNetworkProfileToken(
  token: string,
  host: string,
  fetcher: typeof fetch = fetch
): Promise<string | null> {
  if (
    !token ||
    token.length > 4096 ||
    /[\r\n\0]/.test(token) ||
    normalizeGitHttpsHost(host) !== host
  ) {
    return null
  }
  try {
    const response = await fetcher(`https://${host}/api/v4/user`, {
      method: 'GET',
      redirect: 'error',
      headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    })
    if (response.status !== 200 || !response.body) {
      return null
    }
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > MAX_USER_RESPONSE_BYTES) {
        return null
      }
      chunks.push(chunk)
    }
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    )
    if (!parsed || typeof parsed !== 'object' || !('username' in parsed)) {
      return null
    }
    return typeof parsed.username === 'string' ? normalizeGitLabNetworkUser(parsed.username) : null
  } catch {
    return null
  }
}
