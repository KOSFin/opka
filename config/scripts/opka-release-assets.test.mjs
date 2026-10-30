import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  completeRelease,
  fileDigest,
  serverLauncher,
  serverPackagePaths,
  validateBetaVersion
} from './opka-release-assets.mjs'
import { NODE_RUNTIME_ASSETS } from '../../src/shared/node-runtime-pin.ts'

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), 'opka-assets-'))
  roots.push(root)
  for (const { kind, names } of [
    { kind: 'macos', names: ['opka-macos-arm64.dmg', 'opka-macos-arm64.zip', 'latest-mac.yml'] },
    { kind: 'server', names: ['opka-server-linux-x64.tar.gz'] },
    { kind: 'android', names: ['opka-android.apk', 'latest-android.json'] }
  ]) {
    const assets = []
    for (const name of names) {
      const content =
        name === 'latest-android.json'
          ? JSON.stringify({
              schemaVersion: 1,
              packageName: 'com.kosfin.opka.mobile',
              version: '0.1.0-rc.1',
              versionCode: 1,
              certificateSha256: 'a'.repeat(64),
              bytes: 17,
              sha256: await fileDigest(join(root, 'opka-android.apk')),
              url: 'https://github.com/KOSFin/opka/releases/download/v0.1.0-rc.1/opka-android.apk'
            })
          : 'synthetic fixture'
      await writeFile(join(root, name), content)
      assets.push({
        name,
        bytes: Buffer.byteLength(content),
        sha256: await fileDigest(join(root, name))
      })
    }
    await writeFile(
      join(root, `opka-${kind}-provenance.json`),
      JSON.stringify({
        version: '0.1.0-rc.1',
        commit: 'source-a',
        sourceRepository: 'KOSFin/opka',
        ...(kind === 'android' ? { versionCode: 1, certificateSha256: 'a'.repeat(64) } : {}),
        assets
      })
    )
  }
  return root
}
describe('Opka release assets', () => {
  it.skipIf(process.platform === 'win32')(
    'reports the installed content version instead of an inherited caller version',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'opka-server-launcher-'))
      roots.push(root)
      await mkdir(join(root, 'orcad'))
      await mkdir(join(root, 'runtimes'), { recursive: true })
      await writeFile(join(root, 'orcad', '.version'), '0.1.0+123456abcdef')
      await writeFile(
        join(root, 'runtimes', 'node'),
        '#!/bin/sh\nprintf "%s\\n" "$ORCA_VERSION"\n',
        { mode: 0o700 }
      )
      await writeFile(join(root, 'opka-server'), serverLauncher('runtimes/node'))
      expect(
        execFileSync('sh', [join(root, 'opka-server')], {
          encoding: 'utf8',
          env: { ...process.env, ORCA_VERSION: 'other-app' }
        }).trim()
      ).toBe('0.1.0+123456abcdef')
      await writeFile(join(root, 'orcad', '.version'), '')
      expect(() =>
        execFileSync('sh', [join(root, 'opka-server')], {
          env: { ...process.env, ORCA_VERSION: 'other-app' },
          stdio: 'pipe'
        })
      ).toThrow()
    }
  )
  it('uses a full slot beside its pinned runtime rather than deleted template scratch output', () => {
    const root = join(tmpdir(), 'opka-package-fixture')
    expect(serverPackagePaths(root)).toEqual({
      slot: join(root, 'orcad'),
      node: join(
        root,
        'runtimes',
        `node-${NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256}`,
        'bin',
        'node'
      )
    })
  })
  it('requires an explicit beta version rather than a local or stable build', () => {
    expect(validateBetaVersion('1.4.236-rc.1')).toBe('1.4.236-rc.1')
    for (const bad of ['', '0.1.0', '0.1.0-rc.0', '0.1.0-local.1', '../a', '$(command)']) {
      expect(() => validateBetaVersion(bad)).toThrow()
    }
    for (const older of ['0.1.0-rc.1', '1.4.213-rc.1', '1.4.235-rc.1']) {
      expect(() => validateBetaVersion(older)).toThrow('compatibility version')
    }
  })
  it('checks the complete asset set and hashes both payloads and provenance', async () => {
    const root = await releaseFixture()
    await completeRelease(root, '0.1.0-rc.1', 'source-a')
    const checksums = await readFile(join(root, 'SHA256SUMS'), 'utf8')
    expect(checksums.trim().split('\n')).toHaveLength(9)
    expect(checksums).toContain('  opka-macos-arm64.dmg')
    expect(checksums).toContain('  opka-server-linux-x64.tar.gz')
    await expect(completeRelease(root, '0.1.0-rc.1', 'source-b')).rejects.toThrow('source commit')
    await writeFile(join(root, 'opka-macos-arm64.dmg'), 'tampered')
    await expect(completeRelease(root, '0.1.0-rc.1', 'source-a')).rejects.toThrow('changed')
  })
  it('qualifies installers in the PR and cannot publish from a pull request', () => {
    const pr = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
    const installers = parse(readFileSync('.github/workflows/opka-installers.yml', 'utf8'))
    const release = parse(readFileSync('.github/workflows/opka-release.yml', 'utf8'))
    const server = parse(readFileSync('.github/workflows/opka-server-template.yml', 'utf8'))
    expect(pr.jobs.verify.needs).toContain('installers')
    expect(pr.jobs.installers.uses).toBe('./.github/workflows/opka-installers.yml')
    expect(pr.jobs.installers.secrets).toBe('inherit')
    expect(pr.jobs.installers.with.version).toContain('1.4.236-rc.')
    expect(installers.permissions).toEqual({ contents: 'read' })
    expect(installers.jobs.mac.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
    expect(installers.jobs.mac.env.CSC_FOR_PULL_REQUEST).toBe('true')
    expect(
      installers.jobs.mac.steps.find(
        (step) => step.name === 'Package without publishing or claiming Developer ID signing'
      ).run
    ).toContain('--config.mac.identity=-')
    expect(installers.jobs.mac.env.ORCA_REQUIRE_ORCAD_TEMPLATE).toBe('1')
    expect(server.jobs.desktop_template.env.OPKA_VERSION).toBe('${{ inputs.version }}')
    expect(Object.keys(release.on)).toEqual(['workflow_dispatch'])
    expect(release.jobs.admission.if).toBe("github.ref == 'refs/heads/main'")
    expect(release.jobs.qualification.uses).toBe('./.github/workflows/pr.yml')
    expect(release.jobs.qualification.secrets).toBe('inherit')
    expect(release.jobs.android_update.secrets).toBe('inherit')
    expect(release.jobs.publish.needs).toEqual(['qualification', 'android_update'])
    expect(release.jobs.publish.permissions).toEqual({ contents: 'write' })
  })
})
