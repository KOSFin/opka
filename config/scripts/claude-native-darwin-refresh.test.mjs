import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'
import { runDarwinNativeRefreshQualification } from './claude-native-darwin-refresh.mjs'
import { createDarwinRefreshServer } from './claude-native-darwin-refresh-server.mjs'

const skip = isDarwinNativeProbeCi()
test(
  'refresh qualification refuses outside isolated Darwin CI before reading paths',
  { skip },
  async () => {
    await assert.rejects(runDarwinNativeRefreshQualification({}), /isolated Darwin CI/)
  }
)
test('TLS setup refuses outside isolated Darwin CI before writing files', { skip }, async () => {
  await assert.rejects(createDarwinRefreshServer(undefined), /isolated Darwin CI/)
})
