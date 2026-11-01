import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function verifyTestedAndroid(proof, provenance, apk, expected) {
  const stages = ['baseline-idle', 'real-ui', 'native-https']
  const identity =
    /^[a-f0-9]{40}$/.test(expected.commit ?? '') &&
    /^\d+\.\d+\.\d+-rc\.[1-9]\d*$/.test(expected.version ?? '') &&
    proof?.schemaVersion === 1 &&
    proof.candidateRebuilt === false &&
    proof.sourceCommit === expected.commit &&
    provenance.commit === expected.commit &&
    proof.version === expected.version &&
    provenance.version === expected.version &&
    proof.packageName === 'com.kosfin.opka.mobile' &&
    proof.packageName === provenance.packageName &&
    proof.versionCode === provenance.versionCode &&
    /^[a-f0-9]{64}$/.test(expected.certificate ?? '') &&
    proof.certificateSha256 === expected.certificate &&
    provenance.certificateSha256 === expected.certificate
  if (!identity) {
    throw new Error('Android acceptance identity differs from the release artifact.')
  }
  if (
    proof.allPassed !== true ||
    !Array.isArray(proof.stages) ||
    proof.stages.length !== stages.length ||
    stages.some(
      (stage) =>
        proof.stages.filter((item) => item.stage === stage && item.status === 'passed').length !== 1
    )
  ) {
    throw new Error('Every required Android artifact acceptance stage must pass.')
  }
  const digest = createHash('sha256').update(apk).digest('hex')
  const asset = provenance.assets?.find((item) => item.name === 'opka-android.apk')
  if (
    proof.apkSha256 !== digest ||
    proof.apkBytes !== apk.length ||
    asset?.sha256 !== digest ||
    asset?.bytes !== apk.length
  ) {
    throw new Error('Published Android APK is not the exact tested APK.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(process.argv[2] ?? 'dist')
  const proof = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  verifyTestedAndroid(
    proof,
    JSON.parse(readFileSync(resolve(root, 'opka-android-provenance.json'), 'utf8')),
    readFileSync(resolve(root, 'opka-android.apk')),
    {
      commit: process.env.GITHUB_SHA,
      version: process.env.OPKA_VERSION,
      certificate: process.env.OPKA_REQUIRE_ANDROID_CERTIFICATE_SHA256
    }
  )
}
