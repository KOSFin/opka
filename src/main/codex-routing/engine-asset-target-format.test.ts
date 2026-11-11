import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertEngineAssetTargetFormat } from './engine-asset-target-format'

let directory: string | undefined
async function fixture(bytes: Buffer): Promise<string> {
  directory ??= await mkdtemp(join(tmpdir(), 'engine-target-'))
  const path = join(directory, 'engine')
  await writeFile(path, bytes)
  return path
}
afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = undefined
  }
})

it('accepts only a matching Linux ELF machine', async () => {
  const bytes = Buffer.alloc(64)
  bytes.write('\x7fELF', 0, 'binary')
  bytes[4] = 2
  bytes[5] = 1
  bytes.writeUInt16LE(62, 18)
  const path = await fixture(bytes)
  await expect(assertEngineAssetTargetFormat(path, 'linux-x64')).resolves.toBeUndefined()
  await expect(assertEngineAssetTargetFormat(path, 'linux-arm64')).rejects.toThrow('architecture')
})

it('rejects a matching name with a wrong Mach-O or PE machine', async () => {
  const macho = Buffer.alloc(64)
  macho.writeUInt32LE(0xfeedfacf, 0)
  macho.writeUInt32LE(0x0100000c, 4)
  let path = await fixture(macho)
  await expect(assertEngineAssetTargetFormat(path, 'darwin-arm64')).resolves.toBeUndefined()
  await expect(assertEngineAssetTargetFormat(path, 'darwin-x64')).rejects.toThrow('architecture')

  const pe = Buffer.alloc(512)
  pe.write('MZ')
  pe.writeUInt32LE(128, 0x3c)
  pe.write('PE\0\0', 128, 'binary')
  pe.writeUInt16LE(0x8664, 132)
  path = await fixture(pe)
  await expect(assertEngineAssetTargetFormat(path, 'win32-x64')).resolves.toBeUndefined()
  await expect(assertEngineAssetTargetFormat(path, 'win32-arm64')).rejects.toThrow('architecture')
})
