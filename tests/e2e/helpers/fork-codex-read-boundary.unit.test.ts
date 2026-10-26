import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareForkCodexReadBoundary } from './fork-codex-read-boundary'

it('allows only the selected executable outside runtime dependencies, retaining home and write fences', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fork-codex-boundary-')))
  try {
    const bin = join(root, 'probe-bin')
    mkdirSync(bin)
    const executable = join(root, 'codex')
    writeFileSync(executable, 'synthetic executable')
    const { profile } = prepareForkCodexReadBoundary(bin, executable, [bin])
    const policy = readFileSync(profile, 'utf8')
    expect(policy).toContain(`(allow file-read* (literal ${JSON.stringify(executable)}))`)
    expect(policy).not.toContain(`(allow file-read* (subpath ${JSON.stringify(root)}))`)
    expect(policy).toContain(`(deny file-read* file-write* (subpath ${JSON.stringify(homedir())}))`)
    expect(policy).toContain('(deny file-write*)')
    expect(policy).toContain(`(subpath ${JSON.stringify(bin)})`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
