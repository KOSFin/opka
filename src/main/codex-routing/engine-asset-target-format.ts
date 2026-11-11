import { open } from 'node:fs/promises'

const MACHO_64_LE = 0xfeedfacf
const MACHO_X64 = 0x01000007
const MACHO_ARM64 = 0x0100000c

/** A signed manifest digest alone cannot catch an accidentally cross-built engine. */
export async function assertEngineAssetTargetFormat(path: string, target: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(4096)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    const [platform, arch] = target.split('-')
    let valid = false
    if (platform === 'linux' && bytesRead >= 20) {
      valid =
        header[0] === 0x7f &&
        header.toString('ascii', 1, 4) === 'ELF' &&
        header[4] === 2 &&
        header[5] === 1 &&
        header.readUInt16LE(18) === (arch === 'x64' ? 62 : arch === 'arm64' ? 183 : -1)
    } else if (platform === 'darwin' && bytesRead >= 8) {
      valid =
        header.readUInt32LE(0) === MACHO_64_LE &&
        header.readUInt32LE(4) ===
          (arch === 'x64' ? MACHO_X64 : arch === 'arm64' ? MACHO_ARM64 : -1)
    } else if (platform === 'win32' && bytesRead >= 64 && header.toString('ascii', 0, 2) === 'MZ') {
      const offset = header.readUInt32LE(0x3c)
      valid =
        offset + 6 <= bytesRead &&
        header.toString('ascii', offset, offset + 4) === 'PE\0\0' &&
        header.readUInt16LE(offset + 4) ===
          (arch === 'x64' ? 0x8664 : arch === 'arm64' ? 0xaa64 : -1)
    }
    if (!valid) {
      throw new Error(
        'Routing engine binary format or execution-host architecture differs from its pin.'
      )
    }
  } finally {
    await file.close()
  }
}
