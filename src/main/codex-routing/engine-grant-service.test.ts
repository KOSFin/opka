import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CodexEngineGrantService } from './engine-grant-service'
import { publishEngineGrant, type EngineGrantAccount } from './engine-grant-files'
import type {
  EngineDeviceLoginOptions,
  EngineDeviceLoginOutcome
} from './engine-device-login-process'
import { reserveEngineWriter } from './engine-writer-ownership'

const roots: string[] = []
const services: CodexEngineGrantService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function grant(id = 'provider-a', token = 'synthetic-access') {
  return JSON.stringify({
    type: 'codex',
    account_id: id,
    access_token: token,
    refresh_token: 'synthetic-refresh',
    id_token: `synthetic.${Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: id }
      })
    ).toString('base64url')}.synthetic`
  })
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opka-engine-grant-'))
  roots.push(root)
  let account: EngineGrantAccount | null = {
    id: '10000000-0000-4000-8000-000000000001',
    providerAccountId: 'provider-a',
    rosterRevision: 'r1'
  }
  const original = { ...account }
  const others = new Map<string, EngineGrantAccount>()
  let finish = (): void => {}
  let outcome: EngineDeviceLoginOutcome = { verdict: 'exited', closed: true, cancelled: false }
  let loginOptions: EngineDeviceLoginOptions | undefined
  let produced = grant()
  let idle = true
  let insideLease = (): void => {}
  let waitForActivation = false
  const service = new CodexEngineGrantService({
    directory: root,
    engine: {
      binaryPath: join(root, 'pinned-engine'),
      expectedSha256: 'a'.repeat(64),
      memoryMiB: 128
    },
    readAccount: (id) => (account?.id === id ? account : (others.get(id) ?? null)),
    assertEnrollmentIdle: () => {
      if (!idle) {
        throw new Error('unverifiable previous child')
      }
    },
    assertExclusiveProfile: () => {},
    withActivationLease: async (_expected, publish, signal) => {
      if (waitForActivation) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('synthetic cancelled lease')), {
            once: true
          })
        })
      }
      insideLease()
      return publish()
    },
    runLogin: async (options) => {
      loginOptions = options
      writeFileSync(join(options.authDirectory, 'engine-created.json'), produced, { mode: 0o600 })
      options.onPrompt({
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-12345'
      })
      await new Promise<void>((resolve) => {
        finish = resolve
        options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return outcome
    }
  })
  services.push(service)
  const begin = (owner = 'device-a') =>
    service.begin(owner, {
      accountId: original.id,
      expectedRosterRevision: account?.rosterRevision ?? 'r1'
    })
  return {
    root,
    service,
    original,
    begin,
    finish: () => finish(),
    login: () => loginOptions,
    change: (next: EngineGrantAccount | null) => {
      account = next
    },
    add: (next: EngineGrantAccount) => {
      others.set(next.id, next)
    },
    produce: (contents: string) => {
      produced = contents
    },
    outcome: (next: EngineDeviceLoginOutcome) => {
      outcome = next
    },
    idle: (value: boolean) => {
      idle = value
    },
    insideLease: (callback: () => void) => {
      insideLease = callback
    },
    waitForActivation: () => {
      waitForActivation = true
    }
  }
}

it('publishes only after child close, uses shared active root and keeps descriptors outside the watch', async () => {
  const f = fixture()
  const start = f.begin()
  await tick()
  expect(f.service.get('device-a', start.id).status).toBe('waiting')
  expect(f.service.readConnection(f.original.id)).toBeNull()
  expect(readdirSync(join(f.root, 'active-auth'))).toEqual([])
  f.finish()
  await tick()
  expect(f.service.get('device-a', start.id)).toMatchObject({ status: 'complete' })
  expect(f.service.readConnection(f.original.id)).toMatchObject({
    accountId: f.original.id,
    rosterRevision: 'r1'
  })
  const reference = f.service.readyAuthReference(f.original.id)
  expect(reference.directory).toBe(join(f.root, 'active-auth'))
  expect(readdirSync(reference.directory)).toEqual([reference.credentialId])
  expect(readdirSync(join(f.root, 'connections', f.original.id))).toEqual(['connection.json'])
  expect(readdirSync(join(f.root, 'staging'))).toEqual([])
  if (process.platform !== 'win32') {
    expect(statSync(join(reference.directory, reference.credentialId)).mode & 0o777).toBe(0o600)
  }
})

it('uses one shared active auth directory for two roster accounts with distinct descriptors', () => {
  const f = fixture()
  const second = {
    ...f.original,
    id: '10000000-0000-4000-8000-000000000002',
    providerAccountId: 'provider-b'
  }
  f.add(second)
  publishEngineGrant(f.root, f.original, grant())
  publishEngineGrant(f.root, second, grant('provider-b'))
  const firstRef = f.service.readyAuthReference(f.original.id)
  const secondRef = f.service.readyAuthReference(second.id)
  expect(firstRef.directory).toBe(secondRef.directory)
  expect(firstRef.credentialId).not.toBe(secondRef.credentialId)
  expect(firstRef.prefix).not.toBe(secondRef.prefix)
  expect(readdirSync(firstRef.directory).sort()).toEqual(
    [firstRef.credentialId, secondRef.credentialId].sort()
  )
  expect(readdirSync(join(f.root, 'connections')).sort()).toEqual([f.original.id, second.id].sort())
})

it('does not accept CLI exit success without a fresh native engine grant', async () => {
  const f = fixture()
  f.produce('{}')
  const start = f.begin()
  await tick()
  f.finish()
  await tick()
  expect(f.service.get('device-a', start.id).status).toBe('failed')
  expect(readdirSync(join(f.root, 'active-auth'))).toEqual([])
})

it('refuses SIWC bindings as substitutes for a native backend grant', async () => {
  const f = fixture()
  f.produce(JSON.stringify({ ...JSON.parse(grant()), use_siwc: true }))
  const start = f.begin()
  await tick()
  f.finish()
  await tick()
  expect(f.service.get('device-a', start.id).status).toBe('failed')
  expect(f.service.readConnection(f.original.id)).toBeNull()
})

it('remains one grant and one descriptor after repeated reconnections', async () => {
  const f = fixture()
  for (let index = 0; index < 20; index += 1) {
    const start = f.begin()
    await tick()
    f.finish()
    await tick()
    expect(f.service.get('device-a', start.id).status).toBe('complete')
  }
  const reference = f.service.readyAuthReference(f.original.id)
  expect(readdirSync(reference.directory)).toEqual([reference.credentialId])
  expect(readdirSync(join(f.root, 'connections', f.original.id))).toEqual(['connection.json'])
  expect(readdirSync(join(f.root, 'staging'))).toEqual([])
})

it('does not confuse another device or roster target with the pending code', async () => {
  const f = fixture()
  const start = f.begin()
  await tick()
  expect(() => f.begin('device-b')).toThrow(/Another device/)
  expect(() => f.service.get('device-b', start.id)).toThrow(/not available/)
  f.change({ ...f.original, rosterRevision: 'r2' })
  expect(() => f.begin()).toThrow(/previous account sign-in/)
  await tick()
  expect(f.service.get('device-a', start.id).status).toBe('cancelled')
  expect(f.service.readConnection(f.original.id)).toBeNull()
  expect(readdirSync(join(f.root, 'staging'))).toEqual([])
})

it.each(['delete', 'reauth', 'cancel'])(
  'invalidates pending %s without publishing or creating a roster entry',
  async (action) => {
    const f = fixture()
    const start = f.begin()
    await tick()
    if (action === 'delete') {
      f.change(null)
    }
    if (action === 'reauth') {
      f.change({ ...f.original, rosterRevision: 'r2' })
    }
    if (action === 'cancel') {
      f.service.cancel('device-a', start.id)
    } else {
      f.service.invalidateAccount(f.original.id)
    }
    await tick()
    expect(f.service.get('device-a', start.id).status).toBe('cancelled')
    expect(readdirSync(join(f.root, 'active-auth'))).toEqual([])
    expect(readdirSync(join(f.root, 'staging'))).toEqual([])
  }
)

it('rechecks roster identity/revision inside the host activation lease', async () => {
  const f = fixture()
  const start = f.begin()
  await tick()
  f.insideLease(() => f.change({ ...f.original, rosterRevision: 'r2' }))
  f.finish()
  await tick()
  expect(f.service.get('device-a', start.id).status).toBe('failed')
  expect(readdirSync(join(f.root, 'active-auth'))).toEqual([])
})

it('retains the previous valid grant when fresh consent has the wrong strong identity', async () => {
  const f = fixture()
  const previous = publishEngineGrant(
    f.root,
    f.original,
    grant('provider-a', 'synthetic-old-access')
  )
  f.produce(grant('provider-b'))
  const start = f.begin()
  await tick()
  f.finish()
  await tick()
  expect(f.service.get('device-a', start.id).status).toBe('failed')
  expect(f.service.readConnection(f.original.id)).toEqual(previous)
  expect(readFileSync(join(f.root, 'active-auth', previous.credentialId), 'utf8')).toContain(
    'synthetic-old-access'
  )
})

it('token refresh changes do not invalidate identity-bound descriptors; a crash marker does', async () => {
  const f = fixture()
  const descriptor = publishEngineGrant(f.root, f.original, grant())
  const file = join(f.root, 'active-auth', descriptor.credentialId)
  const refreshed = JSON.parse(readFileSync(file, 'utf8'))
  refreshed.access_token = 'synthetic-new-access'
  refreshed.refresh_token = 'synthetic-new-refresh'
  writeFileSync(file, JSON.stringify(refreshed), { mode: 0o600 })
  expect(f.service.readConnection(f.original.id)).toEqual(descriptor)
  writeFileSync(join(f.root, 'connections', f.original.id, 'activation.pending'), 'pending', {
    mode: 0o600
  })
  expect(f.service.readConnection(f.original.id)).toBeNull()
})

it('an unverifiable child leaves only its fixed stage and prevents unsafe reuse', async () => {
  const f = fixture()
  f.outcome({ verdict: 'unverifiable', closed: false, cancelled: true })
  const start = f.begin()
  await tick()
  f.finish()
  await tick()
  expect(f.service.get('device-a', start.id).status).toBe('failed')
  expect(existsSync(join(f.root, 'staging', f.original.id))).toBe(true)
  f.idle(false)
  const retry = f.begin()
  await tick()
  expect(f.service.get('device-a', retry.id).status).toBe('failed')
  expect(readdirSync(join(f.root, 'staging'))).toEqual([f.original.id])
  expect(readdirSync(join(f.root, 'active-auth'))).toEqual([])
})

it('hides a consumed code and aborts a pending activation lease without publishing', async () => {
  const f = fixture()
  f.waitForActivation()
  const start = f.begin()
  await tick()
  f.finish()
  await tick()
  expect(f.service.phase('device-a', start.id)).toBe('activation')
  expect(f.service.get('device-a', start.id)).toMatchObject({ status: 'starting' })
  expect(f.service.get('device-a', start.id)).not.toHaveProperty('userCode')
  f.service.cancel('device-a', start.id)
  await tick()
  expect(f.service.get('device-a', start.id).status).toBe('cancelled')
  expect(readdirSync(join(f.root, 'active-auth'))).toEqual([])
  expect(readdirSync(join(f.root, 'staging'))).toEqual([])
})

it('does not delete a fixed stage while its crashed enrollment writer remains unknown', async () => {
  const f = fixture()
  const stage = join(f.root, 'staging', f.original.id)
  const writer = reserveEngineWriter({
    directory: join(stage, 'runtime'),
    assertExclusive: () => {}
  })
  const start = f.begin()
  await tick()
  expect(f.service.get('device-a', start.id).status).toBe('failed')
  expect(existsSync(join(stage, 'runtime', 'writer-owner.json'))).toBe(true)
  expect(f.login()).toBeUndefined()
  writer.cancelBeforeSpawn()
})

it('does not start a different account enrollment until an older staged writer is proven absent', async () => {
  const f = fixture()
  const other = {
    id: '10000000-0000-4000-8000-000000000002',
    providerAccountId: 'provider-b',
    rosterRevision: 'r1'
  }
  f.add(other)
  const stage = join(f.root, 'staging', f.original.id)
  const writer = reserveEngineWriter({
    directory: join(stage, 'runtime'),
    assertExclusive: () => {}
  })
  const failed = f.service.begin('device-a', { accountId: other.id, expectedRosterRevision: 'r1' })
  await tick()
  expect(f.service.get('device-a', failed.id).status).toBe('failed')
  expect(f.login()).toBeUndefined()
  expect(existsSync(join(f.root, 'staging', other.id))).toBe(false)
  writer.cancelBeforeSpawn()
  f.produce(grant(other.providerAccountId))
  const retried = f.service.begin('device-a', { accountId: other.id, expectedRosterRevision: 'r1' })
  await tick()
  f.finish()
  await tick()
  expect(f.service.get('device-a', retried.id).status).toBe('complete')
  expect(existsSync(stage)).toBe(false)
})
