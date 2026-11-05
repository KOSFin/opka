import { lstatSync, opendirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { engineCredentialFilename } from './engine-account-connection'
import { ensurePrivateEngineDirectory } from './engine-runtime-config'
import { assertEngineWriterIdle } from './engine-writer-ownership'
import {
  readEngineGrantConnection,
  removeEngineGrantConnection,
  type EngineGrantAccount
} from './engine-grant-files'

/** Caller holds the native roster mutation lease; unknown credentials must never enter the watcher. */
export function reconcileEngineAuthDirectory(options: {
  directory: string
  accounts: readonly EngineGrantAccount[]
  assertExclusiveProfile: () => void
}): void {
  options.assertExclusiveProfile()
  assertEngineWriterIdle({
    directory: join(options.directory, 'runtime'),
    assertExclusive: options.assertExclusiveProfile
  })
  const directory = join(options.directory, 'active-auth')
  ensurePrivateEngineDirectory(directory)
  const accounts = new Map(
    options.accounts.map((account) => [engineCredentialFilename(account.id), account])
  )
  if (accounts.size !== options.accounts.length) {
    throw new Error('Routing account credential names are not unique.')
  }
  const scan = opendirSync(directory)
  const files: { name: string; base: string; id: string; temporary: boolean; lock: boolean }[] = []
  try {
    for (let entry = scan.readSync(); entry; entry = scan.readSync()) {
      const match = /^(opka-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.json)(.*)$/i.exec(
        entry.name
      )
      const suffix = match?.[3] ?? ''
      const temporary =
        /^\.tmp\.\d{1,32}$/.test(suffix) || /^\.\d+\.[a-f0-9-]{36}\.tmp$/.test(suffix)
      if (
        files.length >= 256 ||
        !match ||
        match[1] !== engineCredentialFilename(match[2]) ||
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        (suffix !== '' && suffix !== '.lock' && !temporary)
      ) {
        throw new Error('Unknown routing credential entries require host recovery.')
      }
      const stat = lstatSync(join(directory, entry.name))
      if (
        stat.size > 256 * 1024 ||
        (suffix === '.lock' && stat.size !== 0) ||
        (process.platform !== 'win32' &&
          ((stat.mode & 0o077) !== 0 ||
            (typeof process.getuid === 'function' && stat.uid !== process.getuid())))
      ) {
        throw new Error('Routing credential recovery requires private bounded files.')
      }
      files.push({
        name: entry.name,
        base: match[1],
        id: match[2],
        temporary,
        lock: suffix === '.lock'
      })
    }
  } finally {
    scan.closeSync()
  }
  const primary = new Set(
    files.filter((file) => !file.temporary && !file.lock).map((file) => file.base)
  )
  for (const base of primary) {
    const account = accounts.get(base)
    if (account && !readEngineGrantConnection(options.directory, account)) {
      throw new Error(
        'A registered routing credential needs a verified connection before engine startup.'
      )
    }
  }
  const retired = new Set<string>()
  for (const file of files) {
    options.assertExclusiveProfile()
    if (!accounts.has(file.base) && !retired.has(file.base)) {
      removeEngineGrantConnection(options.directory, file.id)
      retired.add(file.base)
    }
    if (file.temporary || (file.lock && (!accounts.has(file.base) || !primary.has(file.base)))) {
      rmSync(join(directory, file.name), { force: true })
    }
  }
}
