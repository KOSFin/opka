import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withNativeBuildWorkspace } from './orcad-prebuild-node-gyp.mjs'

describe('native compilation workspace', () => {
  it('keeps concurrent builds separate and removes scratch files after success', async () => {
    const workspaces = await Promise.all(
      [1, 2].map(() =>
        withNativeBuildWorkspace(async (dir) => {
          writeFileSync(join(dir, 'compiled-addon'), 'fixture')
          expect(existsSync(dir)).toBe(true)
          return dir
        })
      )
    )
    expect(workspaces[0]).not.toBe(workspaces[1])
    for (const dir of workspaces) {
      expect(existsSync(dir)).toBe(false)
    }
  })

  it('cleans scratch files without swallowing compilation errors', async () => {
    let workspace
    await expect(
      withNativeBuildWorkspace(async (dir) => {
        workspace = dir
        writeFileSync(join(dir, 'partial-addon'), 'fixture')
        throw new Error('compiler failed')
      })
    ).rejects.toThrow('compiler failed')
    expect(existsSync(workspace)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('avoids a temporary root containing spaces', async () => {
    const spacedRoot = mkdtempSync(join(tmpdir(), 'orca тест build '))
    try {
      await withNativeBuildWorkspace(
        async (dir) => {
          expect(dir).not.toMatch(/\s/)
          expect(existsSync(dir)).toBe(true)
        },
        { tempRoot: spacedRoot }
      )
      expect(existsSync(spacedRoot)).toBe(true)
    } finally {
      rmSync(spacedRoot, { recursive: true, force: true })
    }
  })
})
