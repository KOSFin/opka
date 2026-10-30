import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileDigest, validateBetaVersion } from './opka-release-assets.mjs'
import opkaVersionCode from '../../mobile/scripts/opka-version-code.cjs'
import { isDirectInvocation } from './script-entry-detection.mjs'

export async function prepareAndroidRelease({
  apk,
  directory,
  version,
  commit,
  versionCode,
  apksigner,
  apkanalyzer,
  certificateSha256
}) {
  validateBetaVersion(version)
  if (
    !Number.isSafeInteger(versionCode) ||
    versionCode < 1 ||
    !/^[a-f0-9]{64}$/.test(certificateSha256 ?? '')
  ) {
    throw new Error(
      'An explicit Android versionCode and pinned signing certificate SHA256 are required'
    )
  }
  const signature = execFileSync(apksigner, ['verify', '--verbose', '--print-certs', apk], {
    encoding: 'utf8'
  })
  const signer = signature
    .match(/Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})/i)?.[1]
    ?.toLowerCase()
  if (
    signer !== certificateSha256 ||
    /Signer #2 certificate/.test(signature) ||
    signature.includes('CN=Android Debug')
  ) {
    throw new Error(
      'APK must have exactly the pinned durable release signer, not an Android debug key'
    )
  }
  for (const [field, expected] of [
    ['application-id', 'com.kosfin.opka.mobile'],
    ['version-name', version],
    ['version-code', String(versionCode)]
  ]) {
    if (
      execFileSync(apkanalyzer, ['manifest', field, apk], { encoding: 'utf8' }).trim() !== expected
    ) {
      throw new Error(`Android ${field} disagrees with the requested release`)
    }
  }
  await mkdir(directory, { recursive: true })
  const name = 'opka-android.apk'
  const output = join(directory, name)
  if (resolve(apk) !== resolve(output)) {
    await copyFile(apk, output)
  }
  const asset = { name, bytes: (await stat(output)).size, sha256: await fileDigest(output) }
  const manifest = {
    schemaVersion: 1,
    packageName: 'com.kosfin.opka.mobile',
    version,
    versionCode,
    certificateSha256,
    bytes: asset.bytes,
    sha256: asset.sha256,
    url: `https://github.com/KOSFin/opka/releases/download/v${version}/${name}`
  }
  await writeFile(join(directory, 'latest-android.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const feed = {
    name: 'latest-android.json',
    bytes: (await stat(join(directory, 'latest-android.json'))).size,
    sha256: await fileDigest(join(directory, 'latest-android.json'))
  }
  await writeFile(
    join(directory, 'opka-android-provenance.json'),
    `${JSON.stringify({ schemaVersion: 1, product: 'Opka', sourceRepository: 'KOSFin/opka', version, commit, packageName: manifest.packageName, versionCode, certificateSha256, assets: [asset, feed] }, null, 2)}\n`
  )
}
if (isDirectInvocation(import.meta.url, process.argv[1])) {
  await prepareAndroidRelease({
    apk: resolve(process.argv[2]),
    directory: resolve(process.argv[3] ?? 'dist'),
    version: process.env.OPKA_VERSION,
    versionCode: opkaVersionCode(process.env.OPKA_VERSION),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    apksigner: process.env.OPKA_APKSIGNER,
    apkanalyzer: process.env.OPKA_APKANALYZER,
    certificateSha256: process.env.OPKA_ANDROID_CERTIFICATE_SHA256
  })
}
