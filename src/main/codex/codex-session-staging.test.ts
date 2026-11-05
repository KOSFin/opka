import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'

const faults = vi.hoisted(() => ({ machine: 'synthetic-machine', remove: '' }))
vi.mock('../persistence/profile-state/profile-state-access-identity', () => ({
  profileStateAccessMachineIdentity: () => faults.machine || null
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (args[0] === faults.remove) {
        throw Object.assign(new Error('locked'), { code: 'EACCES' })
      }
      return actual.rm(...args)
    }
  }
})
import {
  cleanupExitedCodexSessionStages,
  createCodexSessionStagingPath
} from './codex-session-staging'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-session-stage-'))
  faults.machine = 'synthetic-machine'
  faults.remove = ''
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === 900001) {
      throw Object.assign(new Error('exited'), { code: 'ESRCH' })
    }
    if (pid === 900002) {
      throw Object.assign(new Error('unverifiable'), { code: 'EPERM' })
    }
    return true
  })
})
afterEach(async () => {
  faults.remove = ''
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
function stage(
  pid: number,
  machine = faults.machine,
  suffix = '11111111-1111-4111-8111-111111111111'
) {
  const tag = createHash('sha256').update(machine).digest('hex').slice(0, 32)
  return join(root, `.orca-backfill-v2-${tag}-${pid}-${suffix}.tmp`)
}

it('reclaims a crashed copy and a published alias without touching the rollout or ledger', async () => {
  const rollout = join(root, 'rollout-session.jsonl')
  const ledger = join(root, 'audit.jsonl')
  await writeFile(rollout, 'conversation')
  await writeFile(ledger, 'needed work')
  const unpublished = stage(900001)
  const published = stage(900001, faults.machine, '22222222-2222-4222-8222-222222222222')
  await writeFile(unpublished, 'partial copy')
  await link(rollout, published)

  await cleanupExitedCodexSessionStages(root)

  expect((await readdir(root)).sort()).toEqual(['audit.jsonl', 'rollout-session.jsonl'])
  expect(await readFile(rollout, 'utf8')).toBe('conversation')
  expect(await readFile(ledger, 'utf8')).toBe('needed work')
})

it('preserves live, unverifiable, foreign, legacy and symlink stages', async () => {
  const files = [
    stage(process.pid),
    stage(900002),
    stage(900001, 'other-machine'),
    join(root, '.orca-backfill-legacy.tmp')
  ]
  for (const file of files) {
    await writeFile(file, 'keep')
  }
  const outside = join(root, 'user-history')
  await writeFile(outside, 'keep')
  await symlink(outside, stage(900001))
  const before = (await readdir(root)).sort()

  await cleanupExitedCodexSessionStages(root)

  expect((await readdir(root)).sort()).toEqual(before)
  expect(await readFile(outside, 'utf8')).toBe('keep')
})

it('keeps cleanup failures retryable without making resume fail', async () => {
  const file = stage(900001)
  await writeFile(file, 'partial')
  faults.remove = file
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(cleanupExitedCodexSessionStages(root)).resolves.toBeUndefined()
  expect(await readFile(file, 'utf8')).toBe('partial')
  expect(warning).toHaveBeenCalledTimes(1)

  faults.remove = ''
  await cleanupExitedCodexSessionStages(root)
  expect(await readdir(root)).toEqual([])
})

it('bounds reclamation per pass and eventually removes remaining exited stages', async () => {
  for (let index = 0; index < 35; index++) {
    const suffix = `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
    await writeFile(stage(900001, faults.machine, suffix), 'partial')
  }
  await cleanupExitedCodexSessionStages(root)
  expect(await readdir(root)).toHaveLength(3)
  await cleanupExitedCodexSessionStages(root)
  expect(await readdir(root)).toEqual([])
})

it('leaves unknown machine owners and directories untouched', async () => {
  await mkdir(stage(900001))
  const file = stage(900001, faults.machine, '33333333-3333-4333-8333-333333333333')
  await writeFile(file, 'partial')
  faults.machine = ''
  await cleanupExitedCodexSessionStages(root)
  expect(await readdir(root)).toHaveLength(2)
  expect(createCodexSessionStagingPath(root)).toMatch(/\.orca-backfill-[a-f0-9-]{36}\.tmp$/)
})
