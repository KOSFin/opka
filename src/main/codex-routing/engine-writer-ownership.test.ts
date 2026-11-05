import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { reserveEngineWriter } from './engine-writer-ownership'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'opka-engine-owner-'))
  roots.push(directory)
  const state: {
    group: 'live' | 'exited' | 'unverifiable'
    machine: string
    boot: string
  } = {
    group: 'live',
    machine: 'synthetic-host',
    boot: 'boot-a'
  }
  const options = {
    directory,
    assertExclusive: vi.fn(),
    machineIdentity: () => state.machine,
    bootIdentity: () => state.boot,
    groupExists: vi.fn(() => state.group)
  }
  return {
    directory,
    path: join(directory, 'writer-owner.json'),
    state,
    options,
    reserve: () => reserveEngineWriter(options)
  }
}
const group = { pgid: 12345, startedAt: 'clock-tick:1234' }

it('reserves before spawn and refuses an unknown crash window rather than starting a second writer', () => {
  const f = fixture()
  f.reserve()
  expect(readdirSync(f.directory)).toEqual(['writer-owner.json'])
  expect(() => f.reserve()).toThrow('live or unverifiable')
  expect(f.options.groupExists).not.toHaveBeenCalled()
})

it.each(['live', 'unverifiable'] as const)(
  'retains a %s group even when the host parent has exited',
  (verdict) => {
    const f = fixture()
    const owner = f.reserve()
    owner.recordGroup(group)
    f.state.group = verdict
    const contents = readFileSync(f.path, 'utf8')
    expect(() => f.reserve()).toThrow('live or unverifiable')
    expect(readFileSync(f.path, 'utf8')).toBe(contents)
    expect(() => owner.release({ root: 'exited', tree: null })).toThrow('exit remains unverifiable')
  }
)

it('reclaims an empty verified group and keeps repeated launches to one fixed receipt', () => {
  const f = fixture()
  let owner = f.reserve()
  for (let index = 0; index < 100; index++) {
    owner.recordGroup(group)
    f.state.group = 'exited'
    owner = f.reserve()
    expect(readdirSync(f.directory)).toEqual(['writer-owner.json'])
  }
})

it('accepts a proven reboot on the same machine, including a pending spawn window', () => {
  const f = fixture()
  f.reserve()
  f.state.boot = 'boot-b'
  expect(() => f.reserve()).not.toThrow()
  expect(f.options.groupExists).not.toHaveBeenCalled()
})

it('does not confuse a copied profile or another machine reboot with writer exit', () => {
  const f = fixture()
  f.reserve()
  f.state.machine = 'other-host'
  f.state.boot = 'boot-b'
  expect(() => f.reserve()).toThrow('unverifiable execution host')
})

it('verifies leftover stage ownership before deleting any receipt', () => {
  const f = fixture()
  const owner = f.reserve()
  owner.recordGroup(group)
  f.state.group = 'exited'
  writeFileSync(`${f.path}.next`, '{}', { mode: 0o600 })
  const before = readFileSync(f.path, 'utf8')
  expect(() => f.reserve()).toThrow()
  expect(readFileSync(f.path, 'utf8')).toBe(before)
  expect(readdirSync(f.directory)).toHaveLength(2)
})

it('does not follow a receipt symlink or erase its destination', () => {
  if (process.platform === 'win32') {
    return
  }
  const f = fixture()
  const target = join(f.directory, 'user-file')
  writeFileSync(target, 'keep', { mode: 0o600 })
  symlinkSync(target, f.path)
  expect(() => f.reserve()).toThrow('private bounded file')
  expect(readFileSync(target, 'utf8')).toBe('keep')
})

it('releases only after both root and credential-writer exit have been observed', () => {
  const f = fixture()
  const owner = f.reserve()
  owner.recordGroup(group)
  expect(() => owner.release({ root: 'unverifiable', tree: 'exited' })).toThrow()
  f.state.group = 'exited'
  owner.release({ root: 'exited', tree: null })
  expect(readdirSync(f.directory)).toEqual([])
})

it('cannot release a replacement controller receipt', () => {
  const f = fixture()
  const old = f.reserve()
  old.recordGroup(group)
  f.state.group = 'exited'
  f.reserve()
  expect(() => old.release({ root: 'exited', tree: 'exited' })).toThrow('was replaced')
  expect(readdirSync(f.directory)).toEqual(['writer-owner.json'])
})
