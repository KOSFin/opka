import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { bestEffortFsyncDirectorySync } from '../../shared/secure-file'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { ensurePrivateEngineDirectory } from '../codex-routing/engine-runtime-config'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'
import {
  profileStateAccessBootIdentity,
  profileStateAccessMachineIdentity
} from '../persistence/profile-state/profile-state-access-identity'

const Home = z
  .object({
    home: z.string().min(1).max(4096),
    accountId: z.string().min(1).max(256).nullable(),
    active: z.number().int().nonnegative(),
    orphan: z.boolean()
  })
  .strict()
const Ledger = z
  .object({
    version: z.literal(1),
    epoch: z.uuid(),
    machine: z.string().nullable(),
    boot: z.string().nullable(),
    protectAll: z.boolean(),
    homes: z.array(Home)
  })
  .strict()
type HistoryLedger = z.infer<typeof Ledger>
export type NativeHistoryHome = { home: string; accountId: string | null }
type Read = { kind: 'usable'; value: HistoryLedger } | { kind: 'unverifiable' }
function metadata(path: string): Stats | null | 'unverifiable' {
  try {
    return lstatSync(path)
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? null
      : 'unverifiable'
  }
}
export type NativeCodexHistoryLedgerOptions = {
  directory: string
  assertExclusive: () => void
  machineIdentity?: () => string | null
  bootIdentity?: () => string | null
}

/** Orphan history claims protect deletion only; they never prevent normal dialog resume. */
export class NativeCodexHistoryLedger {
  private readonly epoch = randomUUID()
  private readonly path: string
  private readonly stage: string
  constructor(private readonly options: NativeCodexHistoryLedgerOptions) {
    this.path = join(options.directory, 'native-history-owners.json')
    this.stage = `${this.path}.next`
  }
  private fresh(): HistoryLedger {
    const raw = (this.options.machineIdentity ?? profileStateAccessMachineIdentity)()
    return {
      version: 1,
      epoch: this.epoch,
      machine: raw ? createHash('sha256').update(raw).digest('hex') : null,
      boot: (this.options.bootIdentity ?? profileStateAccessBootIdentity)(),
      protectAll: false,
      homes: []
    }
  }
  private read(): Read {
    this.options.assertExclusive()
    const fresh = this.fresh()
    try {
      ensurePrivateEngineDirectory(this.options.directory)
      if (metadata(this.stage) !== null) {
        return { kind: 'unverifiable' }
      }
      const stat = metadata(this.path)
      if (stat === null) {
        return { kind: 'usable', value: fresh }
      }
      if (stat === 'unverifiable') {
        return { kind: 'unverifiable' }
      }
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 512 * 1024 ||
        (process.platform !== 'win32' &&
          ((stat.mode & 0o077) !== 0 ||
            (typeof process.getuid === 'function' && stat.uid !== process.getuid())))
      ) {
        return { kind: 'unverifiable' }
      }
      const value = Ledger.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      if (value.homes.some((entry) => !isAbsolute(entry.home))) {
        return { kind: 'unverifiable' }
      }
      if (value.epoch === this.epoch) {
        return { kind: 'usable', value }
      }
      if (!fresh.machine || fresh.machine !== value.machine || !fresh.boot || !value.boot) {
        return { kind: 'unverifiable' }
      }
      if (fresh.boot !== value.boot) {
        return { kind: 'usable', value: fresh }
      }
      return {
        kind: 'usable',
        value: {
          ...fresh,
          protectAll: value.protectAll,
          homes: value.homes.map((entry) => ({ ...entry, active: 0, orphan: true }))
        }
      }
    } catch {
      return { kind: 'unverifiable' }
    }
  }
  private write(value: HistoryLedger): void {
    this.options.assertExclusive()
    ensurePrivateEngineDirectory(this.options.directory)
    if (metadata(this.stage) !== null) {
      throw new Error('Native history ownership recovery is pending.')
    }
    const fd = openSync(this.stage, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(value))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.options.assertExclusive()
    renameFileWithWindowsRetry(this.stage, this.path)
    bestEffortFsyncDirectorySync(this.options.directory)
  }
  claim(target: NativeHistoryHome): (verdict?: 'exited' | 'unverifiable') => void {
    if (!isAbsolute(target.home) || target.home.length > 4096) {
      throw new Error('A bounded native history HOME is required.')
    }
    const read = this.read()
    // A preserved malformed/foreign/pending receipt already refuses every deletion after restart.
    if (read.kind === 'unverifiable') {
      return () => {}
    }
    const value = read.value
    const key = normalizeRuntimePathForComparison(target.home)
    const existing = value.homes.find(
      (entry) => normalizeRuntimePathForComparison(entry.home) === key
    )
    if (existing) {
      if (!Number.isSafeInteger(existing.active + 1)) {
        value.protectAll = true
      } else {
        existing.active++
      }
    } else {
      value.homes.push({ ...target, active: 1, orphan: false })
    }
    if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) {
      value.protectAll = true
      value.homes = []
    }
    this.write(value)
    let released = false
    return (verdict = 'exited') => {
      if (released) {
        return
      }
      released = true
      const current = this.read()
      if (current.kind !== 'usable' || current.value.epoch !== this.epoch) {
        return
      }
      const entry = current.value.homes.find(
        (home) => normalizeRuntimePathForComparison(home.home) === key
      )
      if (!entry || entry.active === 0) {
        return
      }
      entry.active--
      entry.orphan ||= verdict !== 'exited'
      current.value.homes = current.value.homes.filter((home) => home.orphan || home.active > 0)
      try {
        this.write(current.value)
      } catch {
        /* The old receipt or fixed pending stage continues protecting deletion. */
      }
    }
  }
  assertUnused(target: NativeHistoryHome): void {
    const read = this.read()
    if (read.kind === 'unverifiable') {
      throw new Error(
        'Native history ownership is unverifiable. Preserve the ownership files and prove recovery before deleting this account.'
      )
    }
    if (
      read.value.protectAll ||
      read.value.homes.some(
        (entry) =>
          (entry.active > 0 || entry.orphan) &&
          (normalizeRuntimePathForComparison(entry.home) ===
            normalizeRuntimePathForComparison(target.home) ||
            (target.accountId !== null && entry.accountId === target.accountId))
      )
    ) {
      throw new Error(
        'A surviving or unverifiable native CLI may own this account history. Close and prove its exit, or reboot this host before deleting the account.'
      )
    }
  }
}
