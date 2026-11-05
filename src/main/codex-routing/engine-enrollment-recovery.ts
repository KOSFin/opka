import { opendirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ensurePrivateEngineDirectory } from './engine-runtime-config'
import { assertEngineWriterIdle } from './engine-writer-ownership'

/** A failed enrollment may still have a child; target changes do not grant permission to forget it. */
export function recoverEngineEnrollmentStages(options: {
  directory: string
  assertExclusiveProfile: () => void
  assertEnrollmentIdle: (accountId: string) => void
}): void {
  options.assertExclusiveProfile()
  ensurePrivateEngineDirectory(options.directory)
  const scan = opendirSync(options.directory)
  const accounts: string[] = []
  try {
    for (let entry = scan.readSync(); entry; entry = scan.readSync()) {
      if (
        accounts.length >= 256 ||
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !z.uuid().safeParse(entry.name).success
      ) {
        throw new Error('Routing enrollment staging requires ownership recovery.')
      }
      accounts.push(entry.name)
    }
  } finally {
    scan.closeSync()
  }
  for (const id of accounts) {
    const stage = join(options.directory, id)
    ensurePrivateEngineDirectory(stage)
    options.assertEnrollmentIdle(id)
    assertEngineWriterIdle({
      directory: join(stage, 'runtime'),
      assertExclusive: options.assertExclusiveProfile
    })
    options.assertExclusiveProfile()
    rmSync(stage, { recursive: true })
  }
}
