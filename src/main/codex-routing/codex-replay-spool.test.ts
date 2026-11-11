import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexReplaySpoolBudget } from './codex-replay-spool'

const directories: string[] = []

afterEach(async () => {
  for (const path of directories.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
})

async function budget() {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-codex-replay-'))
  directories.push(directory)
  return new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {})
}

describe('private Codex request replay spool', () => {
  it('replays a 72 MiB image-like JSON string twice without retaining the body in metadata', async () => {
    const owner = await budget()
    const spool = owner.acquire()
    const prefix = Buffer.from('{"model":"probe","input":[{"content":"')
    const suffix = Buffer.from('"}],"stream":true}')
    const chunk = Buffer.alloc(64 * 1024, 0x41)
    const count = 1152
    const sourceHash = createHash('sha256')
    async function* source() {
      for (const value of [prefix, ...Array.from({ length: count }, () => chunk), suffix]) {
        sourceHash.update(value)
        yield value
      }
    }
    expect(await spool.ingest(source())).toMatchObject({ model: 'probe', stream: true })
    expect(await readdir(owner.directory)).toEqual([])
    expect(spool.sha256()).toBe(sourceHash.digest('hex'))
    expect(spool.forwardedBytes('account-A')).toBe(
      prefix.length + chunk.length * count + suffix.length + 'account-A/'.length
    )
    for (let attempt = 0; attempt < 2; attempt++) {
      const replayHash = createHash('sha256')
      let replayBytes = 0
      for await (const part of spool.rewritten('account-A')) {
        replayHash.update(part)
        replayBytes += part.length
      }
      const expectedHash = createHash('sha256')
      expectedHash.update('{"model":"account-A/probe","input":[{"content":"')
      for (let index = 0; index < count; index++) {
        expectedHash.update(chunk)
      }
      expectedHash.update(suffix)
      expect(replayHash.digest('hex')).toBe(expectedHash.digest('hex'))
      expect(replayBytes).toBe(spool.forwardedBytes('account-A'))
    }
    const small = owner.acquire()
    expect(
      await small.ingest(
        (async function* () {
          yield Buffer.from('{"model":"small"}')
        })()
      )
    ).toMatchObject({ model: 'small' })
    expect(owner.snapshot()).toMatchObject({ active: 2, large: 1 })
    await small.dispose()
    await spool.dispose()
    expect(owner.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
    expect(await readdir(owner.directory)).toEqual([])
  }, 90_000)

  it('cleans malformed input and keeps duplicate disposal idempotent', async () => {
    const owner = await budget()
    const spool = owner.acquire()
    await expect(
      spool.ingest(
        (async function* () {
          yield Buffer.from('{"model":"a","input":[1,]}')
        })()
      )
    ).rejects.toThrow()
    await spool.dispose()
    expect(owner.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
    expect(await readdir(owner.directory)).toEqual([])
  })

  it('does not consume a large slot when aggregate reservation fails', async () => {
    const owner = await budget()
    const spool = owner.acquire()
    expect(() => owner.reserve(spool, 256 * 1024 * 1024)).toThrow(
      'Aggregate native replay disk capacity is exhausted.'
    )
    expect(owner.snapshot()).toEqual({ active: 1, large: 0, reservedBytes: 0 })
    await spool.dispose()
    expect(owner.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  })

  it('keeps the reserved disk headroom available to small work during a large replay', async () => {
    const owner = await budget()
    const large = owner.acquire()
    owner.reserve(large, 224 * 1024 * 1024)
    expect(owner.snapshot()).toEqual({
      active: 1,
      large: 1,
      reservedBytes: 448 * 1024 * 1024
    })
    const firstSmall = owner.acquire()
    const secondSmall = owner.acquire()
    owner.reserve(firstSmall, 16 * 1024 * 1024)
    owner.reserve(secondSmall, 16 * 1024 * 1024)
    expect(owner.snapshot()).toEqual({
      active: 3,
      large: 1,
      reservedBytes: 512 * 1024 * 1024
    })
    expect(() => owner.reserve(large, 1)).toThrow('Aggregate native replay disk capacity')
    await Promise.all([large.dispose(), firstSmall.dispose(), secondSmall.dispose()])
    expect(owner.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
    expect(await readdir(owner.directory)).toEqual([])
  })

  it('validates and replays a complete 72 MiB compact window before publication', async () => {
    const owner = await budget()
    const spool = owner.acquire()
    const prefix = Buffer.from('{"output":[{"type":"compaction","encrypted_content":"')
    const suffix = Buffer.from(
      '"},{"type":"message","content":"retained"}],"custom":{"keep":true}}'
    )
    const opaque = Buffer.alloc(64 * 1024, 0x41)
    const expected = createHash('sha256')
    async function* source() {
      expected.update(prefix)
      yield prefix
      for (let index = 0; index < 1152; index++) {
        expected.update(opaque)
        yield opaque
      }
      expected.update(suffix)
      yield suffix
    }
    expect(await spool.ingest(source(), 'response')).toBeNull()
    expect(await readdir(owner.directory)).toEqual([])
    const actual = createHash('sha256')
    for await (const chunk of spool.raw()) {
      actual.update(chunk)
    }
    expect(actual.digest('hex')).toBe(expected.digest('hex'))
    await spool.dispose()
    expect(owner.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
    expect(await readdir(owner.directory)).toEqual([])
  }, 90_000)

  it('frees queue admission after eight simultaneous owned spools settle', async () => {
    const owner = await budget()
    const spools = Array.from({ length: 8 }, () => owner.acquire())
    expect(() => owner.acquire()).toThrow('native replay admission queue is full')
    await Promise.all(spools.map((spool) => spool.dispose()))
    expect(owner.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
    const next = owner.acquire()
    await next.dispose()
    expect(owner.snapshot().active).toBe(0)
  })

  it('releases an interrupted upload and its reserved bytes', async () => {
    const owner = await budget()
    const spool = owner.acquire()
    await expect(
      spool.ingest(
        (async function* () {
          yield Buffer.from('{"model":"synthetic","stream":true,"input":["')
          throw new Error('synthetic upload interrupted')
        })()
      )
    ).rejects.toThrow('synthetic upload interrupted')
    expect(owner.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
    expect(await readdir(owner.directory)).toEqual([])
  })

  it('retries one owned release after a transient owner assertion without double decrement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'synthetic-codex-replay-owner-'))
    directories.push(directory)
    let ownerCurrent = true
    const owner = new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {
      if (!ownerCurrent) {
        throw new Error('Owner fence changed')
      }
    })
    const spool = owner.acquire()
    await spool.ingest(
      (async function* () {
        yield Buffer.from('{"model":"synthetic","stream":true,"input":[]}')
      })()
    )
    ownerCurrent = false
    const first = spool.dispose()
    expect(spool.dispose()).toBe(first)
    await expect(first).rejects.toThrow('Owner fence changed')
    await expect(spool.dispose()).rejects.toThrow('Owner fence changed')
    await expect(spool.raw().next()).rejects.toThrow('incomplete')
    await expect(spool.rewritten('account-A').next()).rejects.toThrow('incomplete')
    expect(owner.snapshot()).toEqual({ active: 1, large: 0, reservedBytes: spool.bytes * 2 })
    expect(await readdir(directory)).toEqual([])

    ownerCurrent = true
    const retry = spool.dispose()
    expect(spool.dispose()).toBe(retry)
    await retry
    await spool.dispose()
    expect(owner.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
    expect(await readdir(directory)).toEqual([])
  })

  it('keeps admission until a failed close can be retried', async () => {
    const owner = await budget()
    const spool = owner.acquire()
    await spool.ingest(
      (async function* () {
        yield Buffer.from('{"model":"synthetic","stream":true,"input":[]}')
      })()
    )
    const handle: unknown = Reflect.get(spool, 'file')
    if (
      !handle ||
      typeof handle !== 'object' ||
      !('close' in handle) ||
      typeof handle.close !== 'function'
    ) {
      throw new Error('Synthetic replay file handle unavailable')
    }
    const close = handle.close
    if (
      !Reflect.set(handle, 'close', async () => {
        throw new Error('synthetic close failure')
      })
    ) {
      throw new Error('Synthetic replay close replacement failed')
    }
    try {
      await expect(spool.dispose()).rejects.toThrow('synthetic close failure')
      expect(owner.snapshot()).toEqual({ active: 1, large: 0, reservedBytes: spool.bytes * 2 })
    } finally {
      Reflect.set(handle, 'close', close)
    }
    await spool.dispose()
    expect(owner.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  })

  it('retains admission when unlink cleanup fails, then releases after a successful retry', async () => {
    const owner = await budget()
    const spool = owner.acquire()
    await mkdir(spool.path)
    await expect(spool.dispose()).rejects.toThrow()
    expect(owner.snapshot()).toEqual({ active: 1, large: 0, reservedBytes: 0 })
    expect(await readdir(owner.directory)).toHaveLength(1)
    await rm(spool.path, { recursive: true })
    await spool.dispose()
    expect(owner.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  })

  it('does not remove a path or release admission after permanent owner loss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'synthetic-codex-replay-foreign-'))
    directories.push(directory)
    let ownerCurrent = true
    const owner = new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {
      if (!ownerCurrent) {
        throw new Error('Owner fence changed')
      }
    })
    const spool = owner.acquire()
    await mkdir(spool.path)
    ownerCurrent = false
    await expect(spool.dispose()).rejects.toThrow('Owner fence changed')
    await expect(spool.dispose()).rejects.toThrow('Owner fence changed')
    await expect(
      spool.ingest(
        (async function* () {
          yield Buffer.from('{"model":"synthetic","stream":true,"input":[]}')
        })()
      )
    ).rejects.toThrow('already used')
    expect(await readdir(directory)).toHaveLength(1)
    expect(owner.snapshot()).toEqual({ active: 1, large: 0, reservedBytes: 0 })
  })
})
