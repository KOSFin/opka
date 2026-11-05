import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readNativeRefreshDiagnosticSummary,
  summarizeNativeRefreshCommand
} from './claude-native-refresh-diagnostics.mjs'

test('native diagnostic keeps only whitelisted enum/Boolean fields and omits request bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opka-native-debug-'))
  try {
    const file = join(root, 'debug.log')
    await writeFile(
      file,
      'request body: OAuth refresh CAS save failed EROFS secret-canary\nOAuth refresh CAS save failed: EPERM sensitive-canary\n'
    )
    const summary = await readNativeRefreshDiagnosticSummary(file)
    assert.equal(summary.categories.refreshCasSaveFailed, true)
    assert.deepEqual(summary.errorCodes, ['EPERM'])
    assert.equal(JSON.stringify(summary).includes('canary'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('native command summary never retains its result text', () => {
  const summary = summarizeNativeRefreshCommand(
    '{"subtype":"success","is_error":true,"result":"private-canary"}'
  )
  assert.equal(summary.isError, true)
  assert.equal(JSON.stringify(summary).includes('canary'), false)
})
