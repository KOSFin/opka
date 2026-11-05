import { runProcess } from '@orca/process-host'
import { randomUUID } from 'node:crypto'
import { writeFile, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'

const FENCE = `(version 1)
(allow default)
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
`

function quotedPaths(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const value = JSON.parse(line.trim())
      if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
        throw new Error('Unexpected CI keychain inventory')
      }
      return value
    })
}

export async function prepareDarwinNativeEnvironment(directory) {
  if (!isDarwinNativeProbeCi()) {
    throw new Error(
      'Native Darwin qualification is allowed only on an isolated GitHub macOS runner'
    )
  }
  await mkdir(directory, { mode: 0o700 })
  const root = await realpath(directory)
  const keychain = join(root, 'fake-only.keychain-db')
  const password = randomUUID()
  const security = async (args) => {
    try {
      const result = await runProcess({ program: '/usr/bin/security', args, timeoutMs: 10000 })
      if (result.code !== 0 || result.timedOut || result.outputTruncated) {
        throw new Error('Isolated CI keychain operation failed')
      }
      return result
    } catch {
      throw new Error('Isolated CI keychain operation failed')
    }
  }
  const search = quotedPaths((await security(['list-keychains', '-d', 'user'])).stdout)
  const defaults = quotedPaths((await security(['default-keychain', '-d', 'user'])).stdout)
  if (search.length > 32 || defaults.length !== 1) {
    throw new Error('Unexpected CI keychain defaults')
  }
  let created = false
  const restore = async () => {
    const results = await Promise.allSettled([
      security(['default-keychain', '-d', 'user', '-s', defaults[0]]),
      security(['list-keychains', '-d', 'user', '-s', ...search])
    ])
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('CI keychain defaults could not be restored')
    }
    if (created) {
      await security(['delete-keychain', keychain])
      created = false
    }
  }
  try {
    await security(['create-keychain', '-p', password, keychain])
    created = true
    await security(['set-keychain-settings', '-lut', '3600', keychain])
    await security(['unlock-keychain', '-p', password, keychain])
    await security(['list-keychains', '-d', 'user', '-s', keychain])
    await security(['default-keychain', '-d', 'user', '-s', keychain])
    const sandbox = join(root, 'loopback-only.sb')
    await writeFile(sandbox, FENCE, { mode: 0o600 })
    return { root, keychain, sandbox, restore }
  } catch (error) {
    await restore()
    throw error
  }
}
