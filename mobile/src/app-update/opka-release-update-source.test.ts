import { describe, expect, it, vi } from 'vitest'
import { createOpkaReleaseUpdateSource, isNewerOpkaVersion } from './opka-release-update-source'
const root = 'https://github.com/KOSFin/opka/releases/download/v1.4.236-rc.5/'
const manifest = {
  schemaVersion: 1,
  packageName: 'com.kosfin.opka.mobile',
  version: '1.4.236-rc.5',
  versionCode: 105,
  sha256: 'a'.repeat(64),
  certificateSha256: 'b'.repeat(64),
  bytes: 1000,
  url: `${root}opka-android.apk`
}
function source(payload: unknown = manifest) {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json([{ ref: 'refs/tags/v1.4.236-rc.5' }, { ref: 'refs/tags/v1.4.236-rc.4' }])
    )
    .mockResolvedValueOnce(
      Response.json({ draft: false, assets: [{ name: 'latest-android.json' }] })
    )
    .mockResolvedValueOnce(Response.json(payload))
  return { fetcher, source: createOpkaReleaseUpdateSource(fetcher) }
}
describe('Opka Android beta channel', () => {
  it('compares rc numbers and rejects downgrades', () => {
    expect(isNewerOpkaVersion('1.4.236-rc.10', '1.4.236-rc.9')).toBe(true)
    expect(isNewerOpkaVersion('1.4.236-rc.9', '1.4.236-rc.10')).toBe(false)
  })
  it('uses the own published release and exact APK feed', async () => {
    const setup = source()
    await expect(setup.source.check('1.4.236-rc.4', new AbortController().signal)).resolves.toEqual(
      { kind: 'available', version: manifest.version, url: `${root}latest-android.json` }
    )
    expect(setup.fetcher.mock.calls[0][0]).toContain('repos/KOSFin/opka/')
  })
  it.each([
    { ...manifest, url: 'https://evil.example/update.apk' },
    { ...manifest, packageName: 'com.stably.orca.mobile' },
    { ...manifest, sha256: 'broken' },
    { ...manifest, version: '1.4.236-rc.6' }
  ])('rejects mismatched or corrupt metadata', async (payload) => {
    await expect(
      source(payload).source.check('1.4.236-rc.4', new AbortController().signal)
    ).rejects.toThrow()
  })
  it('does not call an unavailable feed current', async () => {
    const setup = source()
    setup.fetcher.mockReset().mockResolvedValue(new Response('', { status: 503 }))
    await expect(setup.source.check('1.4.236-rc.4', new AbortController().signal)).rejects.toThrow(
      '503'
    )
  })
})
