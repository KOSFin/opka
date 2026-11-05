import assert from 'node:assert/strict'
import { test } from 'node:test'
import process from 'node:process'
import {
  inspectDarwinRefreshKeychainDomain,
  probeDarwinRefreshKeychainDomain
} from './claude-native-darwin-keychain-domain.mjs'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'
const owned = '/synthetic/owned.keychain-db',
  alias = '/synthetic/alias.keychain-db',
  foreign = '/foreign/login.keychain-db'
const result = (stdout = '', code = 0) => ({
  stdout,
  code,
  signal: null,
  durationMs: 1,
  timedOut: false,
  outputTruncated: false,
  terminationObserved: true
})
const canonicalize = async (path) => (path === alias ? owned : path)
const inspect = (defaultResult, searchResult, extra = {}) =>
  inspectDarwinRefreshKeychainDomain({
    defaultResult,
    searchResult,
    keychain: owned,
    canonicalize,
    ...extra
  })
const platform = { skip: process.platform === 'win32' }
test(
  'accepts only canonical owned fake default/search paths without emitting path values',
  platform,
  async () => {
    const value = await inspect(
      result(JSON.stringify(alias)),
      result(`  ${JSON.stringify(alias)}\n`)
    )
    assert.equal(value.mode, 'owned-default')
    assert.equal(value.search.allOwned, true)
    assert.equal(JSON.stringify(value).includes('/synthetic'), false)
  }
)
test(
  'accepts explicit no-keychain mode only for clean default1 and verified empty search',
  platform,
  async () => {
    const value = await inspect(result('', 1), result(' \n'))
    assert.equal(value.mode, 'isolated-no-keychain')
    assert.equal(value.search.verifiedEmpty, true)
    for (const defaultResult of [result('', 0), result('', 44), result('unparsed', 1)]) {
      assert.equal((await inspect(defaultResult, result(''))).mode, 'unverifiable')
    }
  }
)
test(
  'never infers empty search from failed, missing, malformed or oversized metadata',
  platform,
  async () => {
    const unknown = [
      result('', 1),
      { ...result(''), stdout: undefined },
      result('not JSON'),
      result(JSON.stringify('relative')),
      result(JSON.stringify('/bad\npath')),
      result(Array(33).fill(JSON.stringify(owned)).join('\n')),
      result(' '.repeat(16385)),
      result(JSON.stringify(`/${'a'.repeat(1025)}`))
    ]
    for (const search of unknown) {
      assert.equal((await inspect(result('', 1), search)).mode, 'unverifiable')
    }
  }
)
test(
  'foreign search/default or nonempty search with missing default always refuses',
  platform,
  async () => {
    for (const [defaults, search] of [
      [result(JSON.stringify(owned)), result(JSON.stringify(foreign))],
      [result(JSON.stringify(foreign)), result(JSON.stringify(owned))],
      [result('', 1), result(JSON.stringify(owned))]
    ]) {
      const value = await inspect(defaults, search)
      assert.equal(value.mode, 'unverifiable')
      assert.equal(JSON.stringify(value).includes('/foreign'), false)
    }
  }
)
test(
  'both lookup receipts require actual termination and complete successful search',
  platform,
  async () => {
    for (const flag of [
      { terminationObserved: false },
      { timedOut: true },
      { outputTruncated: true },
      { signal: 'SIGTERM' }
    ]) {
      assert.equal((await inspect({ ...result('', 1), ...flag }, result(''))).mode, 'unverifiable')
      assert.equal((await inspect(result('', 1), { ...result(''), ...flag })).mode, 'unverifiable')
    }
  }
)
test(
  'missing or nonabsolute canonical ownership is unavailable even for an empty search',
  platform,
  async () => {
    for (const resolve of [
      async () => {
        throw new Error('private path')
      },
      async () => 'relative'
    ]) {
      assert.equal(
        (await inspect(result('', 1), result(''), { canonicalize: resolve })).mode,
        'unverifiable'
      )
    }
  }
)
test(
  'domain probing refuses outside isolated Darwin CI before touching OS Security',
  { skip: isDarwinNativeProbeCi() },
  async () => {
    await assert.rejects(probeDarwinRefreshKeychainDomain({}), /isolated Darwin CI/)
  }
)
