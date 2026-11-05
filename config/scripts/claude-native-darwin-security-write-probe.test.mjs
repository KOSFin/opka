import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { test } from 'node:test'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'
import {
  probeDarwinSecurityWrites,
  runFixedSecurityWriteControls
} from './claude-native-darwin-security-write-probe.mjs'

function fixture({
  failSandboxed = false,
  unverifiedWrite = false,
  unverifiedCleanup = false,
  rejectAt = null
} = {}) {
  let item = false
  const calls = []
  const observations = []
  const invoke = async (sandboxed, args, input) => {
    calls.push({ sandboxed, args, input })
    const result = {
      code: 0,
      signal: null,
      stdout: '',
      timedOut: false,
      durationMs: 1,
      terminationObserved: true
    }
    if (args[0] === 'find-generic-password') {
      if (rejectAt === 'read' && item) {
        rejectAt = null
        throw new Error('synthetic-private-rejection')
      }
      return {
        ...result,
        code: item ? 0 : 44,
        stdout: item ? 'opka-noncredential-write-check' : ''
      }
    }
    if (args[0] === 'delete-generic-password') {
      if (rejectAt === 'cleanup') {
        throw new Error('synthetic-private-rejection')
      }
      item = false
      return { ...result, terminationObserved: !unverifiedCleanup }
    }
    assert.equal(args[0], '-i')
    if (rejectAt === 'write') {
      throw new Error('synthetic-private-rejection')
    }
    if (unverifiedWrite) {
      return { ...result, terminationObserved: false }
    }
    if (sandboxed && failSandboxed) {
      return { ...result, code: null, signal: 'SIGTERM', timedOut: true, durationMs: 2000 }
    }
    item = true
    return result
  }
  return {
    calls,
    observations,
    args: {
      keychain: '/synthetic/fake.keychain-db',
      invoke,
      onObservation: (value) => observations.push(value)
    }
  }
}
test(
  'write controls refuse outside isolated Darwin CI before OS access',
  {
    skip: isDarwinNativeProbeCi()
  },
  async () => {
    await assert.rejects(probeDarwinSecurityWrites({}), /isolated Darwin CI/)
  }
)
test(
  'four fake controls use native stdin shape and explicitly clean their owned item',
  {
    skip: process.platform === 'win32'
  },
  async () => {
    const f = fixture()
    await runFixedSecurityWriteControls(f.args)
    assert.equal(f.observations.length, 4)
    assert.equal(
      f.observations.every((value) => value.readMatched && value.cleanupVerified),
      true
    )
    const writes = f.calls.filter((call) => call.args[0] === '-i')
    assert.deepEqual(
      writes.map((call) => call.sandboxed),
      [false, false, true, true]
    )
    const hex = Buffer.from('opka-noncredential-write-check').toString('hex')
    for (const [index, call] of writes.entries()) {
      const expected = `add-generic-password -U -a "runner" -s "opka-native-security-write-preflight" -X "${hex}"${index % 2 ? ' "/synthetic/fake.keychain-db"' : ''}\n`
      assert.equal(call.input === expected, true)
    }
    const cleanup = f.calls.filter((call) => call.args[0] === 'delete-generic-password')
    assert.equal(cleanup.length, 4)
    assert.equal(
      cleanup.every((call) => !call.sandboxed && call.args.at(-1) === f.args.keychain),
      true
    )
    assert.equal(JSON.stringify(f.observations).includes(hex), false)
    assert.equal(JSON.stringify(f.observations).includes(f.args.keychain), false)
  }
)
test(
  'fenced write timeout remains an observation with known cleanup, not a refresh workaround',
  {
    skip: process.platform === 'win32'
  },
  async () => {
    const f = fixture({ failSandboxed: true })
    await runFixedSecurityWriteControls(f.args)
    assert.equal(
      f.observations.slice(0, 2).every((value) => value.write.code === 0),
      true
    )
    for (const value of f.observations.slice(2)) {
      assert.equal(value.readMatched, false)
      assert.equal(value.cleanupVerified, true)
      assert.deepEqual(value.write, {
        code: null,
        signal: 'term',
        elapsed: '1500-2499ms',
        timedOut: true,
        terminationObserved: true
      })
    }
  }
)
test(
  'unobserved write termination does not clean or release the fake keychain',
  {
    skip: process.platform === 'win32'
  },
  async () => {
    const f = fixture({ unverifiedWrite: true })
    await assert.rejects(runFixedSecurityWriteControls(f.args), { nativeCleanupUnverifiable: true })
    assert.equal(
      f.calls.some((call) => call.args[0] === 'delete-generic-password'),
      false
    )
    assert.equal(f.observations[0].cleanupVerified, false)
  }
)
test(
  'unverified cleanup preserves the fake keychain rather than continuing native usage',
  {
    skip: process.platform === 'win32'
  },
  async () => {
    const f = fixture({ unverifiedCleanup: true })
    await assert.rejects(runFixedSecurityWriteControls(f.args), { nativeCleanupUnverifiable: true })
    assert.equal(f.observations.length, 1)
    assert.equal(f.observations[0].cleanupVerified, false)
  }
)

test(
  'rejected write invocation retains unknown helper ownership without deleting its item',
  {
    skip: process.platform === 'win32'
  },
  async () => {
    const f = fixture({ rejectAt: 'write' })
    await assert.rejects(
      runFixedSecurityWriteControls(f.args),
      (error) =>
        error.nativeCleanupUnverifiable === true &&
        !error.message.includes('synthetic-private-rejection')
    )
    assert.equal(
      f.calls.some((call) => call.args[0] === 'delete-generic-password'),
      false
    )
  }
)
test(
  'rejected read and cleanup invocations retain the unknown flag and sanitized observations',
  {
    skip: process.platform === 'win32'
  },
  async () => {
    for (const rejectAt of ['read', 'cleanup']) {
      const f = fixture({ rejectAt })
      await assert.rejects(
        runFixedSecurityWriteControls(f.args),
        (error) =>
          error.nativeCleanupUnverifiable === true &&
          !error.message.includes('synthetic-private-rejection')
      )
      assert.equal(f.observations.length, 1)
      assert.equal(JSON.stringify(f.observations).includes('synthetic-private-rejection'), false)
    }
  }
)
