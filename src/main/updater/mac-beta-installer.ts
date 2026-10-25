import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { productReleaseDownloadUrl } from '../../shared/product-identity'

const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024
const MAX_CHECKSUM_BYTES = 64 * 1024
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

type Installer = { path: string; sha256: string; version: string }
type ReleaseAssetFetch = (url: string, init: RequestInit) => Promise<Response>

export function parseInstallerChecksum(checksums: string, filename: string): string {
  const hashes = checksums.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-f0-9]{64}) [ *](.+)$/i.exec(line)
    return match?.[2] === filename ? [match[1].toLowerCase()] : []
  })
  if (hashes.length !== 1) {
    throw new Error('The Opka release has no unique installer checksum')
  }
  return hashes[0]
}

async function fetchReleaseAsset(
  url: string,
  fetcher: ReleaseAssetFetch,
  signal: AbortSignal
): Promise<Response> {
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'https:' ||
      (parsed.hostname !== 'github.com' && !parsed.hostname.endsWith('.githubusercontent.com'))
    ) {
      throw new Error('Opka update download left GitHub HTTPS hosting')
    }
    const response = await fetcher(url, { redirect: 'manual', signal })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) {
        throw new Error('Opka update redirect has no destination')
      }
      url = new URL(location, url).href
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`Opka update download failed (HTTP ${response.status})`)
    }
    return response
  }
  throw new Error('Too many Opka update redirects')
}

async function consumeResponse(
  response: Response,
  limit: number,
  consume: (chunk: Uint8Array, bytes: number) => Promise<void>
): Promise<void> {
  if (!response.body) {
    throw new Error('Opka update download has no body')
  }
  const reader = response.body.getReader()
  let bytes = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      bytes += result.value.byteLength
      if (bytes > limit) {
        throw new Error('Opka update download exceeded its size limit')
      }
      await consume(result.value, bytes)
    }
    if (bytes === 0) {
      throw new Error('Opka update download is empty')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Downloads only; replacing the app and granting macOS permissions remain user actions. */
export class MacBetaInstaller {
  private installer: Installer | null = null
  constructor(private readonly fetcher: ReleaseAssetFetch) {}

  async download(
    version: string,
    arch: string,
    tempDirectory: string,
    progress: (percent: number) => void
  ): Promise<void> {
    if (arch !== 'arm64' && arch !== 'x64') {
      throw new Error('Unsupported Mac architecture')
    }
    const base = productReleaseDownloadUrl(version)
    const filename = `opka-macos-${arch}.dmg`
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    const checksumResponse = await fetchReleaseAsset(`${base}/SHA256SUMS`, this.fetcher, signal)
    const chunks: Uint8Array[] = []
    await consumeResponse(checksumResponse, MAX_CHECKSUM_BYTES, async (chunk) => {
      chunks.push(chunk)
    })
    const sha256 = parseInstallerChecksum(Buffer.concat(chunks).toString('utf8'), filename)
    const directory = await mkdtemp(join(tempDirectory, 'opka-update-'))
    const destination = join(directory, filename)
    try {
      const response = await fetchReleaseAsset(`${base}/${filename}`, this.fetcher, signal)
      const contentLength = Number(response.headers.get('content-length'))
      const total = Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : 0
      const hash = createHash('sha256')
      const file = await open(destination, 'wx', 0o600)
      try {
        await consumeResponse(response, MAX_INSTALLER_BYTES, async (chunk, bytes) => {
          hash.update(chunk)
          // FileHandle.write can be short even when it succeeds.
          let offset = 0
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await file.write(chunk.subarray(offset))
            if (bytesWritten === 0) {
              throw new Error('Could not write the Opka installer')
            }
            offset += bytesWritten
          }
          if (total) {
            progress(Math.min(99, Math.floor((bytes / total) * 100)))
          }
        })
        await file.sync()
      } finally {
        await file.close()
      }
      if (hash.digest('hex') !== sha256) {
        throw new Error('Opka installer checksum does not match; file discarded')
      }
      this.installer = { path: destination, sha256, version }
      progress(100)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  async openInstaller(version: string, openPath: (path: string) => Promise<string>): Promise<void> {
    const installer = this.installer
    if (!installer || installer.version !== version) {
      throw new Error('Download the Opka installer again before opening it')
    }
    const stat = await lstat(installer.path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INSTALLER_BYTES) {
      throw new Error('The downloaded Opka installer is no longer a regular file')
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(installer.path)) {
      hash.update(chunk)
    }
    if (hash.digest('hex') !== installer.sha256) {
      throw new Error('The downloaded Opka installer changed; download it again')
    }
    const error = await openPath(installer.path)
    if (error) {
      throw new Error(`Could not open the Opka installer: ${error}`)
    }
  }
}
