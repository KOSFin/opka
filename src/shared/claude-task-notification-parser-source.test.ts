import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { readClaudeTaskNotification } from './claude-task-notification-text'

it('keeps the native sandbox parser self-contained after production-style bundling and minification', async () => {
  const bundle = await build({
    stdin: {
      contents: `export { nativeClaudeTaskNotificationParserSource } from ${JSON.stringify(resolve('src/shared/claude-task-notification-text.ts'))}`,
      resolveDir: process.cwd()
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    minify: true,
    write: false
  })
  const context = { module: { exports: {} } }
  runInNewContext(bundle.outputFiles[0].text, context)
  const methods: unknown = context.module.exports
  if (
    !methods ||
    typeof methods !== 'object' ||
    !('nativeClaudeTaskNotificationParserSource' in methods) ||
    typeof methods.nativeClaudeTaskNotificationParserSource !== 'function'
  )
    {throw new Error('The bundled parser generator is absent.')}
  const source: unknown = methods.nativeClaudeTaskNotificationParserSource()
  if (typeof source !== 'string') {throw new Error('The native parser source is invalid.')}
  const parse: unknown = runInNewContext(
    `${source.replace('export function', 'function')};readClaudeTaskNotification`
  )
  if (typeof parse !== 'function') {throw new Error('The native parser is invalid.')}
  for (const text of [
    '',
    'ordinary user input',
    '<task-notification><task-id>actual-id</task-id><status>completed</status><summary>done</summary></task-notification>',
    '<task-notification><task-id>actual-id</task-id><summary>output includes <status>failed</status></summary></task-notification>',
    '<task-notification><task-id>  </task-id><status>completed</status>'
  ])
    {expect(parse(text)).toEqual(readClaudeTaskNotification(text))}
})
