import { afterEach, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureOwnedNativeProbeDirectory } from './claude-native-probe-test-growth'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'opka-growth-'))
  roots.push(root)
  return root
}
const linkTest = it.skipIf(process.platform === 'win32')

it('counts only files inside the owned directory and remains stable', async () => {
  const root = await directory()
  await mkdir(join(root, 'child'))
  await writeFile(join(root, 'child', 'data'), 'abc')
  expect(await measureOwnedNativeProbeDirectory(root)).toEqual({ files: 1, bytes: 3, links: 0 })
  expect(await measureOwnedNativeProbeDirectory(root)).toEqual({ files: 1, bytes: 3, links: 0 })
})
linkTest(
  'counts an outside-directory link without following its huge target or children',
  async () => {
    const root = await directory(),
      outside = await directory()
    const file = join(outside, 'large')
    await writeFile(file, Buffer.alloc(1024 * 1024))
    const link = join(root, 'outside')
    await symlink(outside, link)
    expect(await measureOwnedNativeProbeDirectory(root)).toEqual({
      files: 0,
      bytes: (await lstat(link)).size,
      links: 1
    })
  }
)
linkTest('counts dangling link bytes and observes link removal', async () => {
  const root = await directory(),
    link = join(root, 'dangling')
  await symlink(join(root, 'missing'), link)
  const result = await measureOwnedNativeProbeDirectory(root)
  expect(result).toEqual({ files: 0, bytes: (await lstat(link)).size, links: 1 })
  expect(await measureOwnedNativeProbeDirectory(root)).toEqual(result)
  await rm(link)
  expect(await measureOwnedNativeProbeDirectory(root)).toEqual({ files: 0, bytes: 0, links: 0 })
})
linkTest('refuses a symlink root instead of enumerating its target', async () => {
  const root = await directory(),
    target = await directory(),
    link = join(root, 'root-link')
  await symlink(target, link)
  await expect(measureOwnedNativeProbeDirectory(link)).rejects.toThrow(
    'root is not an owned directory'
  )
})
it('keeps the fixed entry budget', async () => {
  const root = await directory()
  for (let index = 0; index < 2049; index++) {
    await writeFile(join(root, String(index)), '')
  }
  await expect(measureOwnedNativeProbeDirectory(root)).rejects.toThrow('inventory limit')
})
