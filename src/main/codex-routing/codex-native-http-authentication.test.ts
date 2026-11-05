import { expect, it } from 'vitest'
import {
  nativeCodexGatewayLaunch,
  readCodexNativeHttpRequest
} from './codex-native-http-authentication'

const key = 'a'.repeat(64)
const nonce = 'b'.repeat(64)
const path = `/native/${nonce}/v1/responses`

it('keeps profile authentication separate from the per-launch routing capability', () => {
  expect(readCodexNativeHttpRequest(path, `Bearer ${key}`, key)).toEqual({
    token: nonce,
    compact: false
  })
  expect(readCodexNativeHttpRequest(`${path}/compact`, `Bearer ${key}`, key)).toEqual({
    token: nonce,
    compact: true
  })
  expect(readCodexNativeHttpRequest(path, `Bearer ${nonce}`, key)).toEqual({ status: 401 })
  expect(readCodexNativeHttpRequest(path, undefined, key)).toEqual({ status: 401 })
  expect(readCodexNativeHttpRequest('/v1/responses', `Bearer ${key}`, key)).toEqual({ status: 404 })
})

it.each([`${path}?query=1`, `${path}/`, path.replace(nonce, '%62'.repeat(64)), path])(
  'refuses alternate paths or methods (%s)',
  (url) => {
    expect(
      readCodexNativeHttpRequest(url, `Bearer ${key}`, key, url === path ? 'GET' : 'POST')
    ).toEqual({ status: 404 })
  }
)

it('retains the earlier internal transport contract without enabling its route in a native profile', () => {
  expect(readCodexNativeHttpRequest('/v1/responses/compact', `Bearer ${nonce}`)).toEqual({
    token: nonce,
    compact: true
  })
})

it('publishes an independent nonce URL for each live session while sharing only local profile auth', () => {
  const session = { apiKey: nonce, close: () => {} }
  const launch = nativeCodexGatewayLaunch('http://127.0.0.1:1234/v1', key, session)
  expect(launch.baseUrl).toBe(`http://127.0.0.1:1234/native/${nonce}/v1`)
  expect(launch.apiKey).toBe(key)
  expect(launch.routingKey).toBe(nonce)
  expect(launch.close).toBe(session.close)
  expect(
    nativeCodexGatewayLaunch('http://127.0.0.1:1234/v1', key, {
      ...session,
      apiKey: 'c'.repeat(64)
    }).baseUrl
  ).not.toBe(launch.baseUrl)
})
