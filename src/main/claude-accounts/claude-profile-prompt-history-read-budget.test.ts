import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createClaudeProfileReport } from './claude-profile-report'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})
import { mergeClaudeProfilePromptHistory } from './claude-profile-prompt-history'

const roots: string[] = []
afterEach(() => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
function fixture(platform: 'linux' | 'win32') {
  const root = fs.mkdtempSync(join(tmpdir(), 'claude-history-read-budget-'))
  roots.push(root)
  const home = join(root, 'home')
  const profile = join(root, 'profile')
  fs.mkdirSync(home)
  fs.mkdirSync(profile)
  const history = join(home, 'history.jsonl')
  fs.writeFileSync(history, `${'unchanged-large-record'.repeat(4096)}\n`)
  const share = () =>
    mergeClaudeProfilePromptHistory(profile, home, platform, createClaudeProfileReport())
  const reads = () => vi.mocked(fs.readFileSync).mock.calls.filter(([path]) => path === history)
  return { profile, history, share, reads }
}

const platforms =
  process.platform === 'win32' ? (['win32'] as const) : (['linux', 'win32'] as const)
it.each(platforms)(
  'does not reload the whole shared prompt history for unchanged %s profiles',
  (platform) => {
    const { share, reads } = fixture(platform)
    share()
    vi.mocked(fs.readFileSync).mockClear()
    for (let cycle = 0; cycle < 100; cycle++) {
      expect(share()).toBe('unchanged')
    }
    expect(reads()).toHaveLength(0)
  }
)

it('removes a fully drained pending generation without reading the large shared history', () => {
  const { profile, share, reads } = fixture('win32')
  share()
  const pending = join(profile, 'history.jsonl.orca-profile-merge')
  fs.writeFileSync(pending, 'old\n')
  fs.writeFileSync(`${pending}.offset`, '4\n')
  vi.mocked(fs.readFileSync).mockClear()
  share()
  expect(reads()).toHaveLength(0)
  expect(fs.existsSync(pending)).toBe(false)
  expect(fs.existsSync(`${pending}.offset`)).toBe(false)
})

it('still reads once and preserves deduplication when new history really must be merged', () => {
  const { profile, history, share, reads } = fixture('win32')
  share()
  const pending = join(profile, 'history.jsonl.orca-profile-merge')
  const existing = fs.readFileSync(history, 'utf8')
  fs.writeFileSync(pending, `${existing}new-prompt\n`)
  vi.mocked(fs.readFileSync).mockClear()
  share()
  expect(reads()).toHaveLength(1)
  expect(fs.readFileSync(history, 'utf8')).toBe(`${existing}new-prompt\n`)
  vi.mocked(fs.readFileSync).mockClear()
  share()
  expect(reads()).toHaveLength(0)
})
