import { timingSafeEqual } from 'node:crypto'

const CAPABILITY = '[A-Za-z0-9._-]{32,512}'
const nativePath = new RegExp(`^/native/(${CAPABILITY})/v1/responses(/compact)?$`)
const bearer = new RegExp(`^Bearer (${CAPABILITY})$`)

/** A durable local credential authenticates the profile; only a live nonce identifies its launch. */
export function readCodexNativeHttpRequest(
  url: string | undefined,
  authorization: string | undefined,
  profileKey?: string,
  method = 'POST'
): { token: string; compact: boolean } | { status: 401 | 404 } {
  const path =
    profileKey === undefined
      ? /^\/v1\/responses(\/compact)?$/.exec(url ?? '')
      : nativePath.exec(url ?? '')
  if (method !== 'POST' || !path) {
    return { status: 404 }
  }
  const key = bearer.exec(authorization ?? '')?.[1]
  if (!key) {
    return { status: 401 }
  }
  if (
    profileKey !== undefined &&
    (key.length !== profileKey.length ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(profileKey)))
  ) {
    return { status: 401 }
  }
  return profileKey === undefined
    ? { token: key, compact: Boolean(path[1]) }
    : { token: path[1], compact: Boolean(path[2]) }
}

export function nativeCodexGatewayLaunch<T extends { apiKey: string }>(
  url: string,
  profileKey: string,
  session: T
): Omit<T, 'apiKey'> & { baseUrl: string; apiKey: string; routingKey: string } {
  const base = new URL(url)
  base.pathname = `/native/${session.apiKey}/v1`
  return { ...session, baseUrl: base.href, apiKey: profileKey, routingKey: session.apiKey }
}
