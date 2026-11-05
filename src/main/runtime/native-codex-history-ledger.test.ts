import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NativeCodexHistoryLedger } from './native-codex-history-ledger'

const directories: string[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'opka-history-ledger-'))
  directories.push(directory)
  const target = { home: join(directory, 'native-home'), accountId: 'synthetic-account' }
  const create = (machine = 'synthetic-machine', boot = 'boot-one') =>
    new NativeCodexHistoryLedger({
      directory,
      assertExclusive: () => {},
      machineIdentity: () => machine,
      bootIdentity: () => boot
    })
  return { directory, target, create, path: join(directory, 'native-history-owners.json') }
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('retains same-boot external CLI ownership after parent restart without blocking dialog resume', () => {
  const f = fixture()
  const old = f.create()
  const oldRelease = old.claim(f.target)
  const restarted = f.create()
  expect(() => restarted.assertUnused(f.target)).toThrow(/surviving or unverifiable/)
  const release = restarted.claim(f.target)
  release()
  oldRelease()
  expect(() => restarted.assertUnused(f.target)).toThrow(/surviving or unverifiable/)
})

it('clears a valid previous-boot claim only after a proven same-machine reboot', () => {
  const f = fixture()
  f.create().claim(f.target)
  const foreign = f.create('different-machine', 'boot-two')
  expect(() => foreign.assertUnused(f.target)).toThrow(/unverifiable/)
  expect(() => f.create('synthetic-machine', 'boot-two').assertUnused(f.target)).not.toThrow()
})

it.each(['malformed', 'pending', 'foreign'])(
  'preserves %s ownership evidence and permits resume while refusing deletion',
  (kind) => {
    const f = fixture()
    f.create().claim(f.target)
    if (kind === 'malformed') {
      writeFileSync(f.path, '{broken', { mode: 0o600 })
    }
    if (kind === 'pending') {
      writeFileSync(`${f.path}.next`, 'pending', { mode: 0o600 })
    }
    const before = readFileSync(f.path)
    const ledger = kind === 'foreign' ? f.create('foreign-machine') : f.create()
    const release = ledger.claim(f.target)
    release()
    expect(readFileSync(f.path)).toEqual(before)
    expect(() => ledger.assertUnused(f.target)).toThrow(/unverifiable/)
  }
)

it('releases ordinary verified local claims idempotently', () => {
  const f = fixture(),
    ledger = f.create()
  const release = ledger.claim(f.target)
  expect(() => ledger.assertUnused(f.target)).toThrow(/surviving/)
  release()
  release()
  expect(() => ledger.assertUnused(f.target)).not.toThrow()
})

it('keeps a bounded sticky refusal when more than 64 distinct histories survive', () => {
  const f = fixture(),
    ledger = f.create()
  for (let i = 0; i < 80; i++) {
    ledger.claim({ home: join(f.directory, `home-${i}`), accountId: null })
  }
  expect(readFileSync(f.path).byteLength).toBeLessThan(512 * 1024)
  expect(() => ledger.assertUnused(f.target)).toThrow(/surviving/)
  expect(() => f.create('synthetic-machine', 'boot-two').assertUnused(f.target)).not.toThrow()
})

it('does not infer tree exit from wrapper release or routing capability revocation', () => {
  const f = fixture(),
    ledger = f.create()
  ledger.claim(f.target)('unverifiable')
  expect(() => ledger.assertUnused(f.target)).toThrow(/surviving or unverifiable/)
  const resumed = ledger.claim(f.target)
  resumed('exited')
  expect(() => ledger.assertUnused(f.target)).toThrow(/surviving or unverifiable/)
})
