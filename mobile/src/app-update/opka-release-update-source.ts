import { z } from 'zod'
import { compareAppVersions, isValidAppVersion } from '../../../src/shared/app-version'
import type { AppUpdateSource } from './app-update-source'

const API = 'https://api.github.com/repos/KOSFin/opka'
export const OPKA_DOWNLOAD_ROOT = 'https://github.com/KOSFin/opka/releases/download/'
export const opkaAndroidManifestSchema = z.object({
  schemaVersion: z.literal(1),
  packageName: z.literal('com.kosfin.opka.mobile'),
  version: z.string().refine(isValidAppVersion),
  versionCode: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  certificateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z
    .number()
    .int()
    .positive()
    .max(512 * 1024 * 1024),
  url: z.string()
})
export function isNewerOpkaVersion(candidate: string, installed: string): boolean {
  return (
    isValidAppVersion(candidate) &&
    isValidAppVersion(installed) &&
    compareAppVersions(candidate, installed) > 0
  )
}

export function createOpkaReleaseUpdateSource(fetchImpl: typeof fetch): AppUpdateSource {
  return {
    isNewerVersion: isNewerOpkaVersion,
    async check(installedVersion, signal) {
      const reply = await fetchImpl(`${API}/git/matching-refs/tags/v`, { signal })
      if (!reply.ok) {
        throw new Error(`Opka tags HTTP ${reply.status}`)
      }
      const refs = z.array(z.object({ ref: z.string() })).parse(await reply.json())
      const versions = refs
        .map(({ ref }) => ref.replace(/^refs\/tags\/v/, ''))
        .filter(
          (version) =>
            /^\d+\.\d+\.\d+-rc\.[1-9]\d*$/.test(version) &&
            isNewerOpkaVersion(version, installedVersion)
        )
        .sort((a, b) => compareAppVersions(b, a))
        .slice(0, 3)
      for (const version of versions) {
        const release = await fetchImpl(`${API}/releases/tags/v${version}`, { signal })
        if (release.status === 404) {
          continue
        }
        if (!release.ok) {
          throw new Error(`Opka release HTTP ${release.status}`)
        }
        const published = z
          .object({ draft: z.boolean(), assets: z.array(z.object({ name: z.string() })) })
          .parse(await release.json())
        if (
          published.draft ||
          !published.assets.some(({ name }) => name === 'latest-android.json')
        ) {
          continue
        }
        const url = `${OPKA_DOWNLOAD_ROOT}v${version}/latest-android.json`
        const manifestReply = await fetchImpl(url, { signal })
        if (!manifestReply.ok) {
          throw new Error(`Opka Android feed HTTP ${manifestReply.status}`)
        }
        const manifest = opkaAndroidManifestSchema.parse(await manifestReply.json())
        if (
          manifest.version !== version ||
          manifest.url !== `${OPKA_DOWNLOAD_ROOT}v${version}/opka-android.apk`
        ) {
          throw new Error('Opka Android feed identity mismatch')
        }
        return { kind: 'available', version, url }
      }
      return { kind: 'current' }
    }
  }
}
export const opkaReleaseUpdateSource = createOpkaReleaseUpdateSource((input, init) =>
  fetch(input, init)
)
