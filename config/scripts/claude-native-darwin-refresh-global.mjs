import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const missing = (error) => error.code === 'ENOENT'
async function snapshot(path) {
  const stat = await lstat(path).catch((error) => {
    if (missing(error)) {
      return null
    }
    throw error
  })
  if (!stat) {
    return null
  }
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error('Global sentinel is unverified')
  }
  return { hash: digest(await readFile(path)), dev: stat.dev, ino: stat.ino, mode: stat.mode }
}
const same = (a, b) =>
  a?.hash === b?.hash && a?.dev === b?.dev && a?.ino === b?.ino && a?.mode === b?.mode

/** Fake CI only; existing host files are observed, never overwritten. */
export async function prepareDarwinRefreshGlobalSentinels(home) {
  const directory = join(home, '.claude')
  const existing = await lstat(directory).catch((error) => {
    if (missing(error)) {
      return null
    }
    throw error
  })
  if (existing && !existing.isDirectory()) {
    throw new Error('Global sentinel directory is unverified')
  }
  if (!existing) {
    await mkdir(directory, { mode: 0o700 })
  }
  const entries = []
  for (const [path, content] of [
    [join(home, '.claude.json'), { hasCompletedOnboarding: true, syntheticDefaultSentinel: true }],
    [
      join(directory, '.credentials.json'),
      {
        claudeAiOauth: {
          accessToken: 'synthetic-global-access',
          refreshToken: 'synthetic-global-refresh',
          expiresAt: 1,
          scopes: ['user:inference']
        }
      }
    ],
    [join(directory, 'settings.json'), { env: { OPKA_SYNTHETIC_GLOBAL_SENTINEL: 'unchanged' } }]
  ]) {
    const before = await snapshot(path)
    if (!before) {
      await writeFile(path, JSON.stringify(content), { flag: 'wx', mode: 0o600 })
    }
    entries.push({ path, created: !before, expected: before ?? (await snapshot(path)) })
  }
  return {
    async assertUnchanged() {
      for (const entry of entries) {
        if (!same(entry.expected, await snapshot(entry.path))) {
          throw new Error('Native source changed global auth or settings')
        }
      }
    },
    async dispose() {
      for (const entry of entries) {
        if (!same(entry.expected, await snapshot(entry.path))) {
          throw new Error('Global sentinel cleanup is unverified')
        }
      }
      for (const entry of entries) {
        if (entry.created) {
          await unlink(entry.path)
        }
      }
    }
  }
}

export function assertDarwinRefreshKeychainSelection(
  selected,
  fileAccess,
  { freshAccess, fileRefresh }
) {
  if (
    selected?.source !== 'scoped-keychain' ||
    selected.nativeAccess?.accessToken !== freshAccess ||
    fileAccess?.refreshToken !== fileRefresh
  ) {
    throw new Error('Native refresh did not preserve scoped Keychain source precedence')
  }
}

export async function assertDarwinRefreshFileUnchanged(path, expected) {
  const bytes = Buffer.from(expected)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size !== bytes.length || !bytes.equals(await readFile(path))) {
    throw new Error('Native refresh changed the adversarial source file')
  }
}
