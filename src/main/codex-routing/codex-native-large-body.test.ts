import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CodexReplaySpoolBudget } from './codex-replay-spool'

it.skipIf(process.platform === 'win32')(
  'replays a generated 256 MiB image body without an aggregate request-size ceiling',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'synthetic-native-large-body-'))
    const budget = new CodexReplaySpoolBudget(directory, 0, () => {})
    const spool = budget.acquire()
    const chunk = Buffer.alloc(64 * 1024, 65)
    const count = 4096
    const prefix =
      '{"model":"probe","stream":true,"input":[{"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,'
    const suffix = '"}]}]}'
    const original = createHash('sha256')
    async function* source() {
      original.update(prefix)
      yield Buffer.from(prefix)
      for (let index = 0; index < count; index++) {
        original.update(chunk)
        yield chunk
      }
      original.update(suffix)
      yield Buffer.from(suffix)
    }
    try {
      expect(await spool.ingest(source())).toMatchObject({ model: 'probe', stream: true })
      expect(spool.bytes).toBeGreaterThan(256 * 1024 * 1024)
      expect(spool.sha256()).toBe(original.digest('hex'))
      expect(await readdir(directory)).toEqual([])
      const expected = createHash('sha256').update(prefix.replace('"probe"', '"route-A/probe"'))
      for (let index = 0; index < count; index++) {
        expected.update(chunk)
      }
      expected.update(suffix)
      expect(await spool.forwardedSha256('route-A')).toBe(expected.digest('hex'))
      await spool.dispose()
      expect(budget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
      if (process.platform === 'linux') {
        const fds = await readdir('/proc/self/fd')
        const targets = await Promise.all(
          fds.map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => ''))
        )
        expect(targets.some((target) => target.includes(directory))).toBe(false)
      }
    } finally {
      await spool.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  90_000
)
