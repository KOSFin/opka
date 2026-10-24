import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { basename, join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { NODE_RUNTIME_ASSETS } from '../../src/shared/node-runtime-pin.ts'
import { productReleaseDownloadUrl } from '../../src/shared/product-identity.ts'
import { isDirectInvocation } from './script-entry-detection.mjs'

const target = 'linux-x64-glibc'
const packageNames = [
  'opka-macos-arm64.dmg',
  'opka-macos-arm64.zip',
  'opka-server-linux-x64.tar.gz'
]

export async function fileDigest(path, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest(encoding)
}

export function validateBetaVersion(version) {
  if (!/^\d+\.\d+\.\d+-rc\.[1-9]\d*$/.test(version ?? '')) {
    throw new Error('OPKA_VERSION must be an explicit beta version, such as 0.1.0-rc.1')
  }
  productReleaseDownloadUrl(version)
  return version
}

async function recordProvenance(directory, version, commit, kind, files) {
  const assets = []
  for (const name of files) {
    const path = join(directory, name)
    assets.push({ name, bytes: (await stat(path)).size, sha256: await fileDigest(path) })
  }
  await writeFile(
    join(directory, `opka-${kind}-provenance.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: 'Opka',
        sourceRepository: 'KOSFin/opka',
        version,
        commit,
        ...(kind === 'macos' ? { developerIdSigned: false, notarized: false } : {}),
        assets
      },
      null,
      2
    )}\n`
  )
}

async function prepareMac(directory, version, commit) {
  if (process.platform !== 'darwin') {
    throw new Error('Mac qualification requires macOS')
  }
  const bundle = join(directory, 'mac-arm64', 'Opka.app')
  const plist = join(bundle, 'Contents', 'Info.plist')
  for (const [key, expected] of [
    ['CFBundleIdentifier', 'io.github.kosfin.opka'],
    ['CFBundleShortVersionString', version],
    ['CFBundleExecutable', 'Opka']
  ]) {
    const actual = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
      encoding: 'utf8'
    }).trim()
    if (actual !== expected) {
      throw new Error(`Packaged ${key} is ${actual}, expected ${expected}`)
    }
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {
    stdio: 'inherit'
  })
  const manifests = (await readdir(directory)).filter((name) => name.endsWith('-mac.yml'))
  const candidates = await Promise.all(
    manifests.map(async (name) => parse(await readFile(join(directory, name), 'utf8')))
  )
  const manifest = candidates.find((value) => value?.version === version)
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('No generated Mac updater manifest for this exact version')
  }
  for (const file of manifest.files) {
    if (
      !packageNames.slice(0, 2).includes(file.url) ||
      file.sha512 !== (await fileDigest(join(directory, file.url), 'sha512', 'base64'))
    ) {
      throw new Error('Mac updater manifest asset or checksum disagrees')
    }
  }
  await writeFile(join(directory, 'latest-mac.yml'), stringify(manifest))
  await recordProvenance(directory, version, commit, 'macos', [
    ...packageNames.slice(0, 2),
    'latest-mac.yml'
  ])
}

async function prepareServer(directory, version, commit) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Server qualification requires Linux x64')
  }
  const stage = resolve('out/.orcad-template-build', target)
  const runtime = NODE_RUNTIME_ASSETS[target]
  const node = join('runtimes', `node-${runtime.executableSha256}`, 'bin', 'node')
  if ((await fileDigest(join(stage, node))) !== runtime.executableSha256) {
    throw new Error('Server Node pin disagrees')
  }
  // The full package was produced by build-orcad-template, not assembled from a partial manifest.
  execFileSync(join(stage, node), [join(stage, 'orcad', 'orcad.js'), '--orcad-smoke-load-check'], {
    stdio: 'inherit'
  })
  await cp(resolve('LICENSE'), join(stage, 'LICENSE'))
  await writeFile(
    join(stage, 'opka-server'),
    [
      '#!/bin/sh',
      'set -eu',
      'OPKA_INSTALL_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      'export ORCA_USER_DATA="${ORCA_USER_DATA:-${HOME:?}/.opka}"',
      `exec "$OPKA_INSTALL_DIR/${node.split('\\').join('/')}" "$OPKA_INSTALL_DIR/orcad/orcad.js" "$@"`,
      ''
    ].join('\n'),
    { mode: 0o755 }
  )
  await chmod(join(stage, 'opka-server'), 0o755)
  await writeFile(
    join(stage, 'opka-release.json'),
    `${JSON.stringify({ version, commit, target })}\n`
  )
  execFileSync('tar', ['-czf', join(directory, packageNames[2]), '-C', stage, '.'], {
    stdio: 'inherit'
  })
  await recordProvenance(directory, version, commit, 'server', [packageNames[2]])
}

export async function completeRelease(directory, version, commit) {
  const recorded = new Map()
  for (const kind of ['macos', 'server']) {
    const provenance = JSON.parse(
      await readFile(join(directory, `opka-${kind}-provenance.json`), 'utf8')
    )
    if (
      provenance.version !== version ||
      provenance.commit !== commit ||
      provenance.sourceRepository !== 'KOSFin/opka'
    ) {
      throw new Error('Release artifacts do not share the requested source commit and version')
    }
    for (const asset of provenance.assets) {
      if (basename(asset.name) !== asset.name || recorded.has(asset.name)) {
        throw new Error('Invalid asset inventory')
      }
      const path = join(directory, asset.name)
      if ((await stat(path)).size !== asset.bytes || (await fileDigest(path)) !== asset.sha256) {
        throw new Error('Release artifact changed')
      }
      recorded.set(asset.name, asset.sha256)
    }
  }
  for (const name of [...packageNames, 'latest-mac.yml']) {
    if (!recorded.has(name)) {
      throw new Error(`Missing release artifact: ${name}`)
    }
  }
  const files = (await readdir(directory)).filter((name) => name !== 'SHA256SUMS').sort()
  const sums = await Promise.all(
    files.map(async (name) => `${await fileDigest(join(directory, name))}  ${name}`)
  )
  await writeFile(join(directory, 'SHA256SUMS'), `${sums.join('\n')}\n`)
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const [command, output = 'dist'] = process.argv.slice(2)
  const directory = resolve(output)
  const version = validateBetaVersion(process.env.OPKA_VERSION)
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  await mkdir(directory, { recursive: true })
  if (command === 'mac') {
    await prepareMac(directory, version, commit)
  } else if (command === 'server') {
    await prepareServer(directory, version, commit)
  } else if (command === 'complete') {
    await completeRelease(directory, version, commit)
  } else {
    throw new Error('Expected mac, server or complete')
  }
}
