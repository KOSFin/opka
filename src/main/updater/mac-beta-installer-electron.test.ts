import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ request: vi.fn(), fetch: vi.fn() }))
vi.mock('electron', () => ({ net: native }))
import { fetchElectronGetWithManualRedirects } from '../lib/electron-manual-redirect-fetch'
import { MacBetaInstaller } from './mac-beta-installer'

const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

type Reply = { redirect: string } | { body: string }
function serve(reply: (url: string) => Reply) {
  native.fetch.mockRejectedValue(new Error('Redirect was cancelled'))
  native.request.mockImplementation(({ url }: { url: string }) => {
    const request = new EventEmitter()
    return Object.assign(request, {
      abort: vi.fn(),
      end: () =>
        queueMicrotask(() => {
          const response = reply(url)
          if ('redirect' in response) {
            request.emit('redirect', 302, 'GET', response.redirect, {
              location: [response.redirect]
            })
            request.emit('error', new Error('Redirect was cancelled'))
          } else {
            request.emit(
              'response',
              Object.assign(Readable.from([Buffer.from(response.body)]), {
                statusCode: 200,
                headers: {}
              })
            )
          }
        })
    })
  })
}

describe('Mac installer through Electron manual redirects', () => {
  it('streams and verifies GitHub assets despite the native cancellation after each redirect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opka-native-download-'))
    roots.push(root)
    const payload = 'Synthetic installer, not executable'
    const sha256 = createHash('sha256').update(payload).digest('hex')
    serve((url) => {
      if (new URL(url).hostname === 'github.com') {
        return { redirect: `https://release-assets.githubusercontent.com/${url.split('/').pop()}` }
      }
      return { body: url.endsWith('/SHA256SUMS') ? `${sha256}  opka-macos-arm64.dmg\n` : payload }
    })
    const installer = new MacBetaInstaller(fetchElectronGetWithManualRedirects)
    await installer.download('1.4.236-rc.2', 'arm64', root, vi.fn())
    expect(native.request).toHaveBeenCalledTimes(4)
    expect(native.fetch).not.toHaveBeenCalled()
    const open = vi.fn(async () => '')
    await installer.openInstaller('1.4.236-rc.2', open)
    expect(open).toHaveBeenCalledOnce()
  })

  it.each(['http://github.com/file', 'https://untrusted.example/file'])(
    'refuses a native redirect outside GitHub HTTPS: %s',
    async (redirect) => {
      const root = await mkdtemp(join(tmpdir(), 'opka-native-download-'))
      roots.push(root)
      serve(() => ({ redirect }))
      const installer = new MacBetaInstaller(fetchElectronGetWithManualRedirects)
      await expect(installer.download('1.4.236-rc.2', 'arm64', root, vi.fn())).rejects.toThrow(
        'HTTPS'
      )
      expect(native.request).toHaveBeenCalledOnce()
      expect(await readdir(root)).toEqual([])
    }
  )
})
