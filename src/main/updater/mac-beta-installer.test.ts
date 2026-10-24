import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MacBetaInstaller, parseInstallerChecksum } from './mac-beta-installer'

const roots: string[] = []
const payload = 'synthetic DMG fixture, not an executable'
const checksum = createHash('sha256').update(payload).digest('hex')
const filename = 'opka-macos-arm64.dmg'
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture(options: { checksums?: string; installer?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'opka-beta-test-'))
  roots.push(root)
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/SHA256SUMS')
      ? new Response(options.checksums ?? `${checksum}  ${filename}\n`)
      : new Response(options.installer ?? payload)
  )
  return { root, fetcher, installer: new MacBetaInstaller(fetcher) }
}
describe('manual Mac beta installer', () => {
  it('downloads only from its own tagged release, verifies and opens without replacing anything', async () => {
    const { root, installer, fetcher } = await fixture()
    const progress = vi.fn()
    await installer.download('0.1.0-rc.1', 'arm64', root, progress)
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://github.com/KOSFin/opka/releases/download/v0.1.0-rc.1/SHA256SUMS',
      'https://github.com/KOSFin/opka/releases/download/v0.1.0-rc.1/opka-macos-arm64.dmg'
    ])
    const openPath = vi.fn(async (_path: string) => '')
    expect(openPath).not.toHaveBeenCalled()
    await installer.openInstaller('0.1.0-rc.1', openPath)
    expect(openPath).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenLastCalledWith(100)
    await expect(installer.openInstaller('0.1.0-rc.2', openPath)).rejects.toThrow('Download')
  })
  it('discards corrupted payloads and never opens them', async () => {
    const { root, installer } = await fixture({ installer: 'corrupted' })
    await expect(installer.download('0.1.0', 'arm64', root, vi.fn())).rejects.toThrow('checksum')
    expect(await readdir(root)).toEqual([])
    await expect(installer.openInstaller('0.1.0', vi.fn())).rejects.toThrow('Download')
  })
  it('rejects ambiguous checksums before creating files', async () => {
    const { root, installer } = await fixture({ checksums: `${checksum}  ${filename}\n`.repeat(2) })
    await expect(installer.download('0.1.0', 'arm64', root, vi.fn())).rejects.toThrow('unique')
    expect(await readdir(root)).toEqual([])
  })
  it('refuses missing, malformed or unrelated checksum entries', () => {
    expect(() => parseInstallerChecksum(`${checksum}  not-the-installer.dmg`, filename)).toThrow()
    expect(() => parseInstallerChecksum(`invalid  ${filename}`, filename)).toThrow()
    expect(parseInstallerChecksum(`${checksum} *${filename}`, filename)).toBe(checksum)
  })
  it('checks again before opening, including after a failed launch', async () => {
    const { root, installer } = await fixture()
    await installer.download('0.1.0', 'arm64', root, vi.fn())
    const openPath = vi.fn(async (_path: string) => 'OS refused')
    await expect(installer.openInstaller('0.1.0', openPath)).rejects.toThrow('OS refused')
    const path = openPath.mock.calls[0][0]
    await writeFile(path, 'tampered')
    await expect(installer.openInstaller('0.1.0', openPath)).rejects.toThrow('changed')
    expect(openPath).toHaveBeenCalledOnce()
  })
  it.skipIf(process.platform === 'win32')('refuses a substituted symlink', async () => {
    const { root, installer } = await fixture()
    await installer.download('0.1.0', 'arm64', root, vi.fn())
    const openPath = vi.fn(async (_path: string) => '')
    await installer.openInstaller('0.1.0', openPath)
    const path = openPath.mock.calls[0][0]
    const other = join(root, 'other.dmg')
    await writeFile(other, payload)
    await unlink(path)
    await symlink(other, path)
    await expect(installer.openInstaller('0.1.0', openPath)).rejects.toThrow('regular file')
    expect(openPath).toHaveBeenCalledOnce()
  })
  it.each(['http://github.com/asset', 'https://example.com/asset'])(
    'rejects download redirects outside GitHub HTTPS: %s',
    async (location) => {
      const { root } = await fixture()
      const installer = new MacBetaInstaller(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location }
          })
      )
      await expect(installer.download('0.1.0', 'arm64', root, vi.fn())).rejects.toThrow('HTTPS')
    }
  )
  it('bounds checksum downloads and refuses empty assets and HTTP errors', async () => {
    const { root } = await fixture()
    for (const response of [
      new Response('x'.repeat(65537)),
      new Response(''),
      new Response('not found', { status: 404 })
    ]) {
      const installer = new MacBetaInstaller(async () => response)
      await expect(installer.download('0.1.0', 'arm64', root, vi.fn())).rejects.toThrow()
    }
    expect(await readdir(root)).toEqual([])
  })
  it('rejects unsupported architectures and path-like versions before fetching', async () => {
    const { root, fetcher, installer } = await fixture()
    await expect(installer.download('../not-a-tag', 'arm64', root, vi.fn())).rejects.toThrow()
    await expect(installer.download('0.1.0', 'ia32', root, vi.fn())).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
