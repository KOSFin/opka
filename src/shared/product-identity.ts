/** Installation ownership is separate from wire and project-file compatibility. */
export const PRODUCT_IDENTITY = {
  name: 'Opka',
  appId: 'io.github.kosfin.opka',
  protocol: 'opka',
  command: 'opka',
  homeDirectory: '.opka',
  remoteDirectory: '.opka-remote',
  releaseOwner: 'KOSFin',
  releaseRepository: 'opka',
  releaseRepo: 'KOSFin/opka'
} as const

export const PRODUCT_RELEASES_URL = `https://github.com/${PRODUCT_IDENTITY.releaseRepo}/releases`
export const PRODUCT_LATEST_DOWNLOAD_URL = `${PRODUCT_RELEASES_URL}/latest/download`

export function productReleaseDownloadUrl(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Invalid Opka release version')
  }
  return `${PRODUCT_RELEASES_URL}/download/${encodeURIComponent(`v${version}`)}`
}
