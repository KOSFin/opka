import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { recoverEngineEnrollmentStages } from './engine-enrollment-recovery'
import { reserveEngineWriter } from './engine-writer-ownership'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'opka-enrollment-recovery-'))
  roots.push(directory)
  return {
    directory,
    run: () =>
      recoverEngineEnrollmentStages({
        directory,
        assertExclusiveProfile: () => {},
        assertEnrollmentIdle: () => {}
      })
  }
}
it('reclaims a closed abandoned stage before a new account enrollment', () => {
  const f = fixture()
  const stage = join(f.directory, '10000000-0000-4000-8000-000000000001')
  mkdirSync(stage)
  writeFileSync(join(stage, 'synthetic-unpublished-grant'), 'synthetic', { mode: 0o600 })
  f.run()
  expect(existsSync(stage)).toBe(false)
})
it('blocks enrollment on a different target while any prior staged writer remains unknown', () => {
  const f = fixture()
  const stage = join(f.directory, '10000000-0000-4000-8000-000000000001')
  const writer = reserveEngineWriter({
    directory: join(stage, 'runtime'),
    assertExclusive: () => {}
  })
  expect(f.run).toThrow(/writer|host/)
  expect(existsSync(stage)).toBe(true)
  writer.cancelBeforeSpawn()
  f.run()
  expect(existsSync(stage)).toBe(false)
})
it('preserves unknown staging names and refuses recovery', () => {
  const f = fixture()
  writeFileSync(join(f.directory, 'unowned-file'), 'preserve', { mode: 0o600 })
  expect(f.run).toThrow(/ownership recovery/)
  expect(existsSync(join(f.directory, 'unowned-file'))).toBe(true)
})
