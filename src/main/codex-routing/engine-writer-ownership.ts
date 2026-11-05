import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ProviderGroupIdentity } from '../provider-process/provider-group-orphan-guard'
import type { ProviderProcessCloseResult } from '../provider-process/provider-process-close'
import {
  profileStateAccessBootIdentity,
  profileStateAccessMachineIdentity
} from '../persistence/profile-state/profile-state-access-identity'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'
import { ensurePrivateEngineDirectory } from './engine-runtime-config'

const Receipt = z
  .object({
    version: z.literal(1),
    nonce: z.uuid(),
    machine: z.string().min(1).nullable(),
    boot: z.string().min(1).nullable(),
    group: z
      .object({ pgid: z.number().int().positive(), startedAt: z.string().min(1).max(200) })
      .optional()
  })
  .strict()
type WriterReceipt = z.infer<typeof Receipt>
export type EngineWriterOwnershipOptions = {
  directory: string
  assertExclusive: () => void
  machineIdentity?: () => string | null
  bootIdentity?: () => string | null
  groupExists?: (pgid: number) => 'live' | 'unverifiable' | 'exited'
}

function groupExists(pgid: number): 'live' | 'unverifiable' | 'exited' {
  if (process.platform === 'win32') {
    return 'unverifiable'
  }
  try {
    process.kill(-pgid, 0)
    return 'live'
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
      ? 'exited'
      : 'unverifiable'
  }
}

function readReceipt(path: string): WriterReceipt {
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 4096 ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())))
  ) {
    throw new Error('Engine writer ownership receipt is not a private bounded file.')
  }
  return Receipt.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/** A missing parent process alone never excludes its surviving engine credential writer. */
export function reserveEngineWriter(options: EngineWriterOwnershipOptions) {
  options.assertExclusive()
  ensurePrivateEngineDirectory(options.directory)
  const path = join(options.directory, 'writer-owner.json')
  const stage = `${path}.next`
  const rawMachine = (options.machineIdentity ?? profileStateAccessMachineIdentity)()
  const machine = rawMachine ? createHash('sha256').update(rawMachine).digest('hex') : null
  const boot = (options.bootIdentity ?? profileStateAccessBootIdentity)()
  const probe = options.groupExists ?? groupExists
  const remnants = [path, stage].filter(existsSync)
  for (const remnant of remnants) {
    const previous = readReceipt(remnant)
    if (!machine || previous.machine !== machine) {
      throw new Error('Engine writer ownership belongs to an unverifiable execution host.')
    }
    const rebooted = boot !== null && previous.boot !== null && previous.boot !== boot
    if (!rebooted && (!previous.group || probe(previous.group.pgid) !== 'exited')) {
      throw new Error('A previous engine credential writer is live or unverifiable.')
    }
  }
  for (const remnant of remnants) {
    options.assertExclusive()
    rmSync(remnant)
  }
  let receipt: WriterReceipt = { version: 1, nonce: randomUUID(), machine, boot }
  const initial = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(initial, JSON.stringify(receipt))
    fsyncSync(initial)
  } finally {
    closeSync(initial)
  }
  const assertCurrent = () => {
    options.assertExclusive()
    if (readReceipt(path).nonce !== receipt.nonce) {
      throw new Error('Engine writer ownership was replaced.')
    }
  }
  return {
    cancelBeforeSpawn(): void {
      assertCurrent()
      if (receipt.group) {
        throw new Error('An engine writer has already been observed.')
      }
      rmSync(path)
    },
    recordGroup(group: ProviderGroupIdentity) {
      assertCurrent()
      if (receipt.group) {
        throw new Error('Engine writer group identity is already bound.')
      }
      const next = Receipt.parse({ ...receipt, group })
      const fd = openSync(stage, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(next))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      try {
        assertCurrent()
        renameFileWithWindowsRetry(stage, path)
        receipt = next
      } finally {
        rmSync(stage, { force: true })
      }
    },
    release(result: ProviderProcessCloseResult): void {
      assertCurrent()
      const observedTreeExit = result.tree === 'exited'
      const emptyGroup = receipt.group !== undefined && probe(receipt.group.pgid) === 'exited'
      if (result.root !== 'exited' || (!observedTreeExit && !emptyGroup)) {
        throw new Error('Engine credential writer exit remains unverifiable.')
      }
      rmSync(path)
    }
  }
}

/** Must run under the same host mutation lease as the following credential publication. */
export function assertEngineWriterIdle(options: EngineWriterOwnershipOptions): void {
  reserveEngineWriter(options).cancelBeforeSpawn()
}
