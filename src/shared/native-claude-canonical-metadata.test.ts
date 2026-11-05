import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { NativeClaudeCanonicalHookSchema } from './native-claude-canonical-hook'
import { classifyClaudeBackgroundTaskKind } from './claude-background-task-kind'
import { CLAUDE_TERMINAL_BACKGROUND_TASK_STATUSES } from './claude-background-task-inventory'
import {
  nativeClaudeCanonicalMetadata,
  nativeClaudeMetadataField,
  nativeClaudeCanonicalMetadataSource
} from './native-claude-canonical-metadata'
const session_id = '11111111-1111-4111-8111-111111111111'
function read(payload: Record<string, unknown>) {
  return NativeClaudeCanonicalHookSchema.parse(
    nativeClaudeCanonicalMetadata(
      'Stop',
      { session_id, ...payload },
      'engine',
      classifyClaudeBackgroundTaskKind,
      CLAUDE_TERMINAL_BACKGROUND_TASK_STATUSES,
      nativeClaudeMetadataField
    )
  )
}
it('ships only lifecycle facts and preserves actual agent handles without private descriptions', () => {
  const value = read({
    prompt_id: randomUUID(),
    prompt: 'private input',
    authorization: 'private-token',
    background_tasks: [
      {
        id: 'actual-agent',
        type: 'subagent',
        status: 'running',
        description: 'private description'
      },
      { id: 'actual-shell', type: 'local_bash', status: 'done' }
    ]
  })
  expect(value.backgroundTasks).toEqual([
    { id: 'actual-agent', type: 'agent', status: 'running' },
    { id: 'actual-shell', type: 'shell', status: 'completed' }
  ])
  expect(JSON.stringify(value)).not.toContain('private')
  expect(value.backgroundTasksTruncated).toBeUndefined()
})
it('never turns missing, malformed or over-bound native inventories into an empty complete roster', () => {
  expect(read({}).backgroundTasks).toBeUndefined()
  expect(read({ background_tasks: null }).backgroundTasksTruncated).toBe(true)
  expect(read({ background_tasks: [null] }).backgroundTasksTruncated).toBe(true)
  const value = read({
    background_tasks: Array.from({ length: 65 }, (_, i) => ({
      id: `agent-${i}`,
      type: 'subagent',
      status: 'running'
    }))
  })
  expect(value.backgroundTasks).toHaveLength(64)
  expect(value.backgroundTasksTruncated).toBe(true)
})
it('does not erase an oversized child identity and reinterpret its event as the lead', () => {
  expect(read({ agent_id: 'x'.repeat(65) }).nativeOrigin).toBe('unverifiable')
  expect(read({ session_crons: [{}] }).sessionCronsTruncated).toBe(true)
})
it('runs the exact portable serializer after production bundling without outer compiler helpers', async () => {
  const bundle = await build({
    entryPoints: [resolve('src/shared/native-claude-canonical-metadata.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    minify: true,
    keepNames: true,
    write: false
  })
  const imported: unknown = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  )
  if (
    !imported ||
    typeof imported !== 'object' ||
    !('nativeClaudeCanonicalMetadataSource' in imported) ||
    typeof imported.nativeClaudeCanonicalMetadataSource !== 'function'
  ) {
    throw new Error('Missing portable serializer')
  }
  const source = `${imported.nativeClaudeCanonicalMetadataSource()};export {canonicalMetadata};`
  const native: unknown = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )
  if (
    !native ||
    typeof native !== 'object' ||
    !('canonicalMetadata' in native) ||
    typeof native.canonicalMetadata !== 'function'
  ) {
    throw new Error('Missing native serializer')
  }
  expect(
    NativeClaudeCanonicalHookSchema.parse(
      native.canonicalMetadata('Stop', { session_id, background_tasks: [] }, 'engine')
    ).backgroundTasks
  ).toEqual([])
  expect(nativeClaudeCanonicalMetadataSource()).not.toContain('private-token')
})
