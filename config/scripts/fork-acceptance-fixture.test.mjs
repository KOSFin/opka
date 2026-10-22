import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { prepareAcceptanceFixture } from './fork-acceptance-fixture.mjs'

test('acceptance seeding preserves edits and creates independent synthetic projects', () => {
  const area = mkdtempSync(path.join(tmpdir(), 'orca-acceptance-fixture-'))
  try {
    const root = path.join(area, 'workspace')
    prepareAcceptanceFixture(root)
    const config = parse(readFileSync(path.join(root, '.orca/project.yaml'), 'utf8'))
    assert.equal(Object.keys(config.repos).length, 3)
    for (const relative of Object.values(config.repos)) {
      assert.equal(
        execFileSync('git', ['branch', '--show-current'], {
          cwd: path.join(root, relative),
          encoding: 'utf8'
        }).trim(),
        'main'
      )
    }
    const document = path.join(root, 'docs/work/tasks/sample-1/task.md')
    writeFileSync(document, 'Human test changes must survive')
    prepareAcceptanceFixture(root)
    assert.equal(readFileSync(document, 'utf8'), 'Human test changes must survive')
    const second = path.join(area, 'second')
    prepareAcceptanceFixture(second)
    const other = parse(readFileSync(path.join(second, '.orca/project.yaml'), 'utf8'))
    assert.notEqual(config.id, other.id)
    assert.throws(() => prepareAcceptanceFixture(area), /unmarked/)
  } finally {
    rmSync(area, { recursive: true, force: true })
  }
})
