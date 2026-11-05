import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { extractPinnedZipMembers } from '../node-runtime/pinned-zip-members'
import { writeAll } from '../node-runtime/runtime-archive-download'
import { TarByteReader, parseSkillTarHeader } from '../skills/skill-package-tar'

const EXPANDED_LIMIT = 128 * 1024 * 1024
const ENTRY_LIMIT = 32
function entry(path: string, bytes: number, seen: Set<string>, binary: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path) ||
    seen.has(path) ||
    seen.size >= ENTRY_LIMIT ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > (path === binary ? 120 * 1024 * 1024 : 1024 * 1024)
  ) {
    throw new Error('Engine archive contains an unsafe, duplicate or oversized entry')
  }
  seen.add(path)
}

async function zipEntries(path: string, binary: string) {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const length = Math.min(size, 65557)
    const tail = Buffer.alloc(length)
    await file.read(tail, 0, length, size - length)
    let end = length - 22
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) {
      end -= 1
    }
    if (
      end < 0 ||
      tail.readUInt16LE(end + 4) ||
      tail.readUInt16LE(end + 6) ||
      tail.readUInt16LE(end + 8) !== tail.readUInt16LE(end + 10) ||
      end + 22 + tail.readUInt16LE(end + 20) !== length
    ) {
      throw new Error('Engine ZIP end record is invalid')
    }
    const count = tail.readUInt16LE(end + 10),
      bytes = tail.readUInt32LE(end + 12),
      offset = tail.readUInt32LE(end + 16)
    if (count > ENTRY_LIMIT || bytes > 65536 || offset + bytes > size - length + end) {
      throw new Error('Engine ZIP directory exceeds its bounds')
    }
    const directory = Buffer.alloc(bytes)
    await file.read(directory, 0, bytes, offset)
    const entries: { path: string; bytes: number }[] = [],
      seen = new Set<string>()
    let cursor = 0,
      expanded = 0
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > bytes || directory.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error('Engine ZIP entry is invalid')
      }
      const nameLength = directory.readUInt16LE(cursor + 28),
        extra = directory.readUInt16LE(cursor + 30),
        comment = directory.readUInt16LE(cursor + 32)
      const next = cursor + 46 + nameLength + extra + comment
      if (next > bytes || directory.readUInt16LE(cursor + 8) & 1) {
        throw new Error('Engine ZIP entry is encrypted or truncated')
      }
      const attributes = directory.readUInt32LE(cursor + 38)
      const mode = attributes >>> 16
      if (
        directory.readUInt16LE(cursor + 34) ||
        attributes & 0x18 ||
        ((mode & 0o170000) !== 0 && (mode & 0o170000) !== 0o100000)
      ) {
        throw new Error('Engine ZIP contains a link or special file')
      }
      const path = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      const entryBytes = directory.readUInt32LE(cursor + 24)
      entry(path, entryBytes, seen, binary)
      expanded += entryBytes
      entries.push({ path, bytes: entryBytes })
      cursor = next
    }
    if (cursor !== bytes || expanded > EXPANDED_LIMIT) {
      throw new Error('Engine ZIP expanded size or directory is invalid')
    }
    return entries
  } finally {
    await file.close()
  }
}

export async function extractEngineAsset(
  archive: string,
  directory: string,
  binary: string,
  signal: AbortSignal
): Promise<void> {
  if (archive.endsWith('.zip')) {
    const entries = await zipEntries(archive, binary)
    const selected = entries.filter((file) => file.path === binary || file.path === 'LICENSE')
    if (selected.length !== 2) {
      throw new Error('Engine archive is missing binary or MIT license')
    }
    await extractPinnedZipMembers(
      archive,
      directory,
      selected,
      'Routing engine',
      signal,
      entries.filter((file) => !selected.includes(file)).map((file) => file.path)
    )
    return
  }
  const source = createReadStream(archive, { signal }),
    gunzip = createGunzip()
  const completion = pipeline(source, gunzip)
  void completion.catch(() => {})
  const reader = new TarByteReader(gunzip, EXPANDED_LIMIT),
    seen = new Set<string>()
  try {
    for (;;) {
      signal.throwIfAborted()
      const header = parseSkillTarHeader(await reader.readExact(512), true)
      if (!header) {
        for (;;) {
          const block = await reader.readExactOrNull(512)
          if (!block) {
            break
          }
          if (!block.every((byte) => byte === 0)) {
            throw new Error('Engine tar has trailing content')
          }
        }
        break
      }
      entry(header.path, header.size, seen, binary)
      const selected = header.path === binary || header.path === 'LICENSE'
      const handle = selected
        ? await open(join(directory, header.path), 'wx', header.path === binary ? 0o700 : 0o600)
        : null
      try {
        let remaining = header.size
        while (remaining) {
          signal.throwIfAborted()
          const bytes = await reader.readExact(Math.min(65536, remaining))
          if (handle) {
            await writeAll(handle, bytes)
          }
          remaining -= bytes.length
        }
      } finally {
        await handle?.close()
      }
      const padding = (512 - (header.size % 512)) % 512
      if (padding && !(await reader.readExact(padding)).every((byte) => byte === 0)) {
        throw new Error('Engine tar padding is invalid')
      }
    }
    await completion
    if (!seen.has(binary) || !seen.has('LICENSE')) {
      throw new Error('Engine archive is missing binary or MIT license')
    }
    if ((await stat(join(directory, 'LICENSE'))).size > 65536) {
      throw new Error('Engine license exceeds its byte budget')
    }
  } catch (error) {
    source.destroy()
    gunzip.destroy()
    await completion.catch(() => {})
    throw error
  }
}
