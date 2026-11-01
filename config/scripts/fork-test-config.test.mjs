import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { applyForkTestSelection } from './fork-test-config.mjs'

it('narrows each actual project without crossing excluded or isolated measurement boundaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'opka-test-plan-'))
  try {
    mkdirSync(join(root, 'src'))
    for (const name of ['leaf', 'other', 'measurement', 'excluded']) {
      writeFileSync(join(root, 'src', `${name}.test.ts`), '')
    }
    const config = {
      test: {
        include: ['src/*.test.ts'],
        exclude: ['src/excluded.test.ts'],
        projects: [
          {
            test: {
              name: 'unit',
              include: ['src/*.test.ts'],
              exclude: ['src/measurement.test.ts', 'src/excluded.test.ts'],
              maxWorkers: 2
            }
          },
          { test: { name: 'measurement', include: ['src/measurement.test.ts'], maxWorkers: 1 } }
        ]
      }
    }
    const narrowed = applyForkTestSelection(
      config,
      ['src/leaf.test.ts', 'src/measurement.test.ts', 'src/excluded.test.ts'],
      root
    )
    expect(narrowed.test.include.sort()).toEqual(['src/leaf.test.ts', 'src/measurement.test.ts'])
    expect(narrowed.test.projects[0].test.include).toEqual(['src/leaf.test.ts'])
    expect(narrowed.test.projects[1].test.include).toEqual(['src/measurement.test.ts'])
    expect(narrowed.test.projects[1].test.maxWorkers).toBe(1)
    expect(
      applyForkTestSelection(config, [], root).test.projects.every(
        (project) => project.test.include.length === 0
      )
    ).toBe(true)
    expect(config.test.projects[0].test.include).toEqual(['src/*.test.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
