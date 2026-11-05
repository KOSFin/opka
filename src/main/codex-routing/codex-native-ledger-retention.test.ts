import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { engineHostFixture, syntheticTurn } from './codex-engine-host-fixture'

it('bounds the production host/front/session ledger across repeated 1000-turn and 1000-quota batches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opka-native-ledger-'))
  const path = join(root, 'ledger.sqlite')
  let stamps = 0
  const f = engineHostFixture(1000, {
    dbPath: path,
    recordQuotaFailure: () => {
      stamps++
      return true
    }
  })
  try {
    const launch = await f.launch('owned-capability')
    const policy = f.state.policy
    if (!policy) {
      throw new Error('Missing synthetic policy')
    }
    policy.rotation = 'after-turn'
    policy.members.forEach((member) => {
      member.priority = 1
    })
    const files = readdirSync(f.directory).sort()
    const checkpointPages = Number(f.db.db.pragma('wal_autocheckpoint', { simple: true }))
    const pageBytes = Number(f.db.db.pragma('page_size', { simple: true }))
    expect(checkpointPages).toBe(1000)
    const liveWalBound = (checkpointPages + 64) * (pageBytes + 24) + 32
    const measure = () => {
      return {
        main: statSync(path).size,
        wal: statSync(`${path}-wal`).size,
        rows: f.db.db.prepare('SELECT COUNT(*) AS count FROM account_pool_assignments').get(),
        scopes: f.db.db.prepare('SELECT COUNT(*) AS count FROM account_pool_native_scopes').get(),
        pages: f.db.db.pragma('page_count', { simple: true }),
        free: f.db.db.pragma('freelist_count', { simple: true })
      }
    }
    const samples: ReturnType<typeof measure>[] = []
    let request = 0
    for (const mode of ['turn', 'turn', 'quota', 'quota']) {
      policy.rotation = mode === 'turn' ? 'after-turn' : 'on-limit'
      f.stats.quotaOnce = mode === 'quota'
      for (let index = 0; index < 1000; index++) {
        f.stats.models.length = 0
        f.stats.bindings.length = 0
        const response = await syntheticTurn(launch, String(++request))
        expect(response.status).toBe(200)
        expect(f.db.listAccountPoolAssignments()).toHaveLength(1)
        if (mode === 'quota') {
          expect(f.stats.models).toHaveLength(2)
        }
      }
      samples.push(measure())
      expect(readdirSync(f.directory).sort()).toEqual(files)
      expect(samples.at(-1)?.rows).toEqual({ count: 2 })
      expect(samples.at(-1)?.scopes).toEqual({ count: 1 })
    }
    expect(stamps).toBe(2000)
    expect(new Set(samples.map((sample) => sample.main)).size).toBe(1)
    expect(new Set(samples.map((sample) => sample.pages)).size).toBe(1)
    for (const sample of samples) {
      expect(sample.wal).toBeLessThanOrEqual(liveWalBound)
    }
    expect(Math.max(...samples.map((sample) => sample.wal))).toBeGreaterThan(0)
    await launch.revoke()
    expect(f.db.listAccountPoolAssignments()).toHaveLength(0)
    expect(
      f.db.db.prepare('SELECT COUNT(*) AS count FROM account_pool_native_scopes').get()
    ).toEqual({ count: 0 })
    f.db.db.pragma('wal_checkpoint(TRUNCATE)')
    const walAfterFinalCheckpoint = statSync(`${path}-wal`).size
    expect(walAfterFinalCheckpoint).toBe(0)
    console.info('Synthetic production native ledger plateau', {
      batches: 4,
      requests: 4000,
      stamps,
      checkpointPages,
      pageBytes,
      liveWalBound,
      walAfterFinalCheckpoint,
      samples
    })
  } finally {
    await f.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)
