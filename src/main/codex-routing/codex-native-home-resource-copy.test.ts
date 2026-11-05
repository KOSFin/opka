import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import type * as NativeFs from 'node:fs/promises'
import {
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  lstat,
  readdir,
  rm,
  truncate
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it as vitestIt, vi } from 'vitest'
const state = vi.hoisted(() => ({ cloneUnsupported: false, cloneCalls: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NativeFs>()
  return {
    ...actual,
    copyFile: async (
      source: Parameters<typeof actual.copyFile>[0],
      target: Parameters<typeof actual.copyFile>[1],
      mode?: number
    ) => {
      if (mode === constants.COPYFILE_FICLONE_FORCE) {
        state.cloneCalls++
        if (state.cloneUnsupported) {
          throw Object.assign(new Error('fixture clone unsupported'), { code: 'ENOTSUP' })
        }
      }
      return actual.copyFile(source, target, mode)
    }
  }
})
import { planNativeHomeResources } from './codex-native-home-resources'
import { copyNativeHomeResources } from './codex-native-home-resource-copy'
import { copySessionFileWithoutOverwrite } from '../codex/codex-session-backfill-copy'
const it = vitestIt.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
const roots: string[] = []
afterEach(async () => {
  state.cloneUnsupported = false
  state.cloneCalls = 0
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opka-resource-clone-')))
  roots.push(root)
  const source = join(root, 'source'),
    home = join(root, 'owned')
  await mkdir(source)
  await mkdir(home)
  await mkdir(join(source, 'plugins', 'cache'), { recursive: true })
  return { root, source, home }
}
it('accepts realistic large artifacts in metadata without reading them into memory', async () => {
  const f = await fixture(),
    path = join(f.source, 'plugins', 'cache', 'large-artifact')
  await writeFile(path, '', { mode: 0o600 })
  await truncate(path, 384 * 1024 * 1024)
  const plan = await planNativeHomeResources(f.source)
  expect(plan.bytes).toBe(384 * 1024 * 1024)
  expect(plan.files[0].size).toBe(plan.bytes)
  expect(Object.keys(plan.files[0])).not.toContain('bytes')
})
it('falls back to bounded isolated streaming copy when reflinks are unsupported', async () => {
  const f = await fixture(),
    source = join(f.source, 'plugins', 'cache', 'artifact')
  await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 3), { mode: 0o700 })
  state.cloneUnsupported = true
  const plan = await planNativeHomeResources(f.source)
  const result = await copyNativeHomeResources({
    storageRoot: f.root,
    home: f.home,
    plan,
    assertExclusive: () => {}
  })
  expect(result).toMatchObject({ clonedFiles: 0, copiedFiles: 1, copiedBytes: 2 * 1024 * 1024 })
  const target = join(f.home, 'plugins', 'cache', 'artifact')
  expect((await lstat(target)).ino).not.toBe((await lstat(source)).ino)
  expect((await lstat(target)).mode & 0o777).toBe(0o700)
  expect(
    createHash('sha256')
      .update(await readFile(target))
      .digest('hex')
  ).toBe(
    createHash('sha256')
      .update(await readFile(source))
      .digest('hex')
  )
  expect(await readdir(join(f.home, 'plugins', 'cache'))).toEqual(['artifact'])
})
it('refuses a device-wide fallback over budget before copying a large prefix', async () => {
  const f = await fixture()
  for (const name of ['a', 'b', 'c']) {
    const path = join(f.source, 'plugins', 'cache', name)
    await writeFile(path, '', { mode: 0o600 })
    await truncate(path, 384 * 1024 * 1024)
  }
  const plan = await planNativeHomeResources(f.source)
  state.cloneUnsupported = true
  await expect(
    copyNativeHomeResources({ storageRoot: f.root, home: f.home, plan, assertExclusive: () => {} })
  ).rejects.toThrow('one-GiB')
  expect(await readdir(join(f.home, 'plugins', 'cache'))).toEqual([])
})
it('keeps existing exclusive copier behavior and refuses an oversized bounded copy', async () => {
  const f = await fixture(),
    source = join(f.source, 'payload'),
    target = join(f.home, 'payload')
  await writeFile(source, 'original', { mode: 0o600 })
  await expect(
    copySessionFileWithoutOverwrite(source, target, { maximumBytes: 3 })
  ).rejects.toThrow('size bound')
  expect(await readdir(f.home)).toEqual([])
  await copySessionFileWithoutOverwrite(source, target)
  await writeFile(source, 'changed')
  await expect(copySessionFileWithoutOverwrite(source, target)).rejects.toMatchObject({
    code: 'EEXIST'
  })
  expect(await readFile(target, 'utf8')).toBe('original')
})
