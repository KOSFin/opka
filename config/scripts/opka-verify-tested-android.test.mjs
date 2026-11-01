import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'vitest'
import { verifyTestedAndroid } from './opka-verify-tested-android.mjs'

function fixture() {
  const apk = Buffer.from('synthetic signed payload')
  const sha256 = createHash('sha256').update(apk).digest('hex')
  const expected = {
    commit: 'a'.repeat(40),
    verificationCommit: 'd'.repeat(40),
    version: '1.4.236-rc.8',
    certificate: 'b'.repeat(64)
  }
  const provenance = {
    commit: expected.commit,
    version: expected.version,
    versionCode: 100,
    certificateSha256: expected.certificate,
    packageName: 'com.kosfin.opka.mobile',
    assets: [{ name: 'opka-android.apk', sha256, bytes: apk.length }]
  }
  const proof = {
    schemaVersion: 1,
    candidateRebuilt: false,
    sourceCommit: expected.commit,
    verificationCommit: expected.verificationCommit,
    version: expected.version,
    versionCode: 100,
    certificateSha256: expected.certificate,
    packageName: provenance.packageName,
    apkSha256: sha256,
    apkBytes: apk.length,
    allPassed: true,
    stages: ['baseline-idle', 'real-ui', 'native-https'].map((stage) => ({
      stage,
      status: 'passed'
    }))
  }
  return { apk, expected, provenance, proof }
}
test('accepts the exact artifact with all independent stages passed', () => {
  const f = fixture()
  verifyTestedAndroid(f.proof, f.provenance, f.apk, f.expected)
})
test('rejects substituted bytes despite successful source-level checks', () => {
  const f = fixture()
  assert.throws(
    () => verifyTestedAndroid(f.proof, f.provenance, Buffer.from('other apk'), f.expected),
    /exact tested/
  )
})
test('rejects wrong source, signer, rebuilt candidate and missing or failed UI proof', () => {
  for (const change of [
    { sourceCommit: 'c'.repeat(40) },
    { verificationCommit: 'c'.repeat(40) },
    { certificateSha256: 'c'.repeat(64) },
    { candidateRebuilt: true },
    { allPassed: false },
    { stages: [] },
    {
      stages: [
        { stage: 'baseline-idle', status: 'passed' },
        { stage: 'real-ui', status: 'failed' },
        { stage: 'native-https', status: 'passed' }
      ]
    }
  ]) {
    const f = fixture()
    assert.throws(() =>
      verifyTestedAndroid({ ...f.proof, ...change }, f.provenance, f.apk, f.expected)
    )
  }
})
