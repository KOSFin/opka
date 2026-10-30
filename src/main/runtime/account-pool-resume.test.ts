import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareAccountPoolResume } from './account-pool-resume'
const state = vi.hoisted(() => ({ systemHome: '' }))
vi.mock('../codex/codex-home-paths', () => ({
  getSystemCodexHomePath: () => state.systemHome,
  getOrcaManagedCodexHomePath: () => join(state.systemHome, 'mirror'),
  getCodexSessionBackfillStateDirPath: () => join(state.systemHome, 'audit')
}))
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opka-pool-history-'))
  roots.push(root)
  const sourceHome = join(root, 'a')
  const targetHome = join(root, 'b')
  state.systemHome = join(root, 'system')
  return { root, sourceHome, targetHome }
}
it('materializes the exact Codex rollout in the target account without changing its session id', async () => {
  const f = await fixture()
  const relative = join('2026', '10', '30', 'rollout-test-session.jsonl')
  await mkdir(join(f.sourceHome, 'sessions', '2026', '10', '30'), { recursive: true })
  const transcriptPath = join(f.sourceHome, 'sessions', relative)
  const content = '{"type":"session_meta","payload":{"id":"test-session"}}\n'
  await writeFile(transcriptPath, content)
  const result = await prepareAccountPoolResume({
    ...f,
    provider: 'codex',
    providerSession: { key: 'session_id', id: 'test-session', transcriptPath }
  })
  expect(result).toEqual({
    key: 'session_id',
    id: 'test-session',
    transcriptPath: join(f.targetHome, 'sessions', relative)
  })
  expect(await readFile(result.transcriptPath!, 'utf8')).toBe(content)
  expect(await readFile(transcriptPath, 'utf8')).toBe(content)
})
it('refuses a transcript outside the source account', async () => {
  const f = await fixture()
  await mkdir(join(f.sourceHome, 'sessions'), { recursive: true })
  const outside = join(f.root, 'outside.jsonl')
  await writeFile(outside, 'private')
  await expect(
    prepareAccountPoolResume({
      ...f,
      provider: 'codex',
      providerSession: { key: 'session_id', id: 'test', transcriptPath: outside }
    })
  ).rejects.toThrow('outside its owning')
})
it('refuses a symlink that escapes the verified source history', async () => {
  const f = await fixture()
  await mkdir(join(f.sourceHome, 'sessions', '2026', '10', '30'), { recursive: true })
  const outside = join(f.root, 'outside.jsonl')
  await writeFile(outside, 'private')
  const transcriptPath = join(f.sourceHome, 'sessions', '2026', '10', '30', 'rollout-test.jsonl')
  await symlink(outside, transcriptPath)
  await expect(
    prepareAccountPoolResume({
      ...f,
      provider: 'codex',
      providerSession: { key: 'session_id', id: 'test', transcriptPath }
    })
  ).rejects.toThrow('outside its owning')
})
it('keeps Claude history through the existing shared projects directory', async () => {
  const f = await fixture()
  const shared = join(f.root, 'shared-projects')
  await mkdir(shared)
  await mkdir(f.sourceHome)
  await mkdir(f.targetHome)
  await symlink(shared, join(f.sourceHome, 'projects'), 'junction')
  await symlink(shared, join(f.targetHome, 'projects'), 'junction')
  await writeFile(join(shared, 'conversation.jsonl'), '{}')
  const result = await prepareAccountPoolResume({
    ...f,
    provider: 'claude',
    providerSession: {
      key: 'session_id',
      id: 'provider-session',
      transcriptPath: join(f.sourceHome, 'projects', 'conversation.jsonl')
    }
  })
  expect(result.transcriptPath).toBe(join(f.targetHome, 'projects', 'conversation.jsonl'))
  expect(result.id).toBe('provider-session')
})
it('refuses an unrelated Claude target and missing resume evidence', async () => {
  const f = await fixture()
  await mkdir(join(f.sourceHome, 'projects'), { recursive: true })
  await mkdir(join(f.targetHome, 'projects'), { recursive: true })
  const transcriptPath = join(f.sourceHome, 'projects', 'conversation.jsonl')
  await writeFile(transcriptPath, '{}')
  await expect(
    prepareAccountPoolResume({
      ...f,
      provider: 'claude',
      providerSession: { key: 'session_id', id: 'test', transcriptPath }
    })
  ).rejects.toThrow('not shared')
  await expect(
    prepareAccountPoolResume({
      ...f,
      provider: 'claude',
      providerSession: { key: 'session_id', id: 'test' }
    })
  ).rejects.toThrow('exact conversation')
})
