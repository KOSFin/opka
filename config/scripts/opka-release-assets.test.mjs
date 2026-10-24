import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  completeRelease,
  fileDigest,
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
    { kind: 'server', names: ['opka-server-linux-x64.tar.gz'] }
  ]) {
    const assets = []
    for (const name of names) {
      await writeFile(join(root, name), 'synthetic fixture')
      assets.push({ name, bytes: 17, sha256: await fileDigest(join(root, name)) })
    }
    await writeFile(
      join(root, `opka-${kind}-provenance.json`),
      JSON.stringify({
        version: '0.1.0-rc.1',
        commit: 'source-a',
        sourceRepository: 'KOSFin/opka',
        assets
      })
    )
  }
  return root
}
describe('Opka release assets', () => {
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
    expect(validateBetaVersion('0.1.0-rc.1')).toBe('0.1.0-rc.1')
    for (const bad of ['', '0.1.0', '0.1.0-rc.0', '0.1.0-local.1', '../a', '$(command)']) {
      expect(() => validateBetaVersion(bad)).toThrow()
    }
  })
  it('checks the complete asset set and hashes both payloads and provenance', async () => {
    const root = await releaseFixture()
    await completeRelease(root, '0.1.0-rc.1', 'source-a')
    const checksums = await readFile(join(root, 'SHA256SUMS'), 'utf8')
    expect(checksums.trim().split('\n')).toHaveLength(6)
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
    expect(pr.jobs.verify.needs).toContain('installers')
    expect(pr.jobs.installers.uses).toBe('./.github/workflows/opka-installers.yml')
    expect(installers.permissions).toEqual({ contents: 'read' })
    expect(installers.jobs.mac.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
    expect(installers.jobs.mac.env.ORCA_REQUIRE_ORCAD_TEMPLATE).toBe('1')
    expect(Object.keys(release.on)).toEqual(['workflow_dispatch'])
    expect(release.jobs.admission.if).toBe("github.ref == 'refs/heads/main'")
    expect(release.jobs.qualification.uses).toBe('./.github/workflows/pr.yml')
    expect(release.jobs.publish.needs).toBe('qualification')
    expect(release.jobs.publish.permissions).toEqual({ contents: 'write' })
  })
})
