import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { NativeClaudeCoverageEvent } from '../../shared/native-claude-coverage'
import { createClaudeNativeCoverageModule } from './claude-native-coverage-module'

type Hook = (
  api: unknown,
  event: unknown,
  next: (event: unknown) => Promise<unknown>
) => Promise<unknown>
async function fixture() {
  const source = createClaudeNativeCoverageModule(randomUUID(), {
    command: process.execPath,
    args: []
  })
  const module: unknown = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${randomUUID()}`
  )
  if (
    !module ||
    typeof module !== 'object' ||
    !('register' in module) ||
    typeof module.register !== 'function'
  ) {
    throw new Error('Missing generated native module registration.')
  }
  const hooks = new Map<string, Hook>(),
    observations: unknown[] = []
  module.register((name: string, hook: Hook) => {
    hooks.set(name, hook)
    return { catch: () => {} }
  })
  let refused = false
  const api = {
    session: { id: async () => 'actual-native-session' },
    prompt: { read: async () => ({ text: '', cursor: 0 }) },
    process: {
      run: async (_argv: unknown, init: { stdin: string }) => {
        const value = JSON.parse(init.stdin)
        observations.push(NativeClaudeCoverageEvent.parse(value.observation))
        return {
          exitCode: refused ? 1 : 0,
          isStdoutTruncated: false,
          stdout: JSON.stringify({ sequence: value.sequence, healthy: true })
        }
      }
    }
  }
  return {
    api,
    observations,
    refuse: () => {
      refused = true
    },
    call(name: string, event: unknown, next: (event: unknown) => Promise<unknown>) {
      const hook = hooks.get(name)
      if (!hook) {
        throw new Error('Missing generated native event.')
      }
      return hook(api, event, next)
    }
  }
}

it('does not clear a newer native draft when an older asynchronous composer read returns', async () => {
  const f = await fixture()
  const edit = (text: string) => ({
    text: '',
    cursor: 0,
    start: 0,
    end: 0,
    inputText: text,
    origin: { kind: 'composer' }
  })
  await f.call('prompt.edit', edit('first'), async () => ({ text: 'first', cursor: 5 }))
  let readStarted = () => {},
    finishRead = (_draft: { text: string; cursor: number }) => {}
  const started = new Promise<void>((resolve) => {
    readStarted = resolve
  })
  const pendingRead = new Promise<{ text: string; cursor: number }>((resolve) => {
    finishRead = resolve
  })
  f.api.prompt.read = async () => {
    readStarted()
    return pendingRead
  }
  const pending = f.call(
    'prompt.submit',
    { text: 'first', origin: { kind: 'composer' } },
    async () => ({ text: 'first' })
  )
  await started
  await f.call('prompt.edit', edit('new draft'), async () => ({ text: 'new draft', cursor: 9 }))
  finishRead({ text: '', cursor: 0 })
  expect(await pending).toEqual({ text: 'first' })
  expect(
    f.observations.filter((value) => NativeClaudeCoverageEvent.parse(value).kind === 'draft')
  ).toEqual([{ kind: 'draft', active: true }])
  await f.call('prompt.change', { text: '', cursor: 0 }, async () => ({ text: '', cursor: 0 }))
  expect(
    f.observations.filter((value) => NativeClaudeCoverageEvent.parse(value).kind === 'draft')
  ).toEqual([
    { kind: 'draft', active: true },
    { kind: 'draft', active: false }
  ])
})

it('preserves typed text but refuses model submission after a missing private acknowledgement', async () => {
  const f = await fixture()
  f.refuse()
  expect(
    await f.call(
      'prompt.edit',
      { text: '', start: 0, end: 0, inputText: 'keep my draft' },
      async () => ({ text: 'keep my draft', cursor: 13 })
    )
  ).toEqual({ text: 'keep my draft', cursor: 13 })
  let entered = false
  const result = await f.call(
    'prompt.submit',
    { text: 'keep my draft', origin: { kind: 'composer' } },
    async () => {
      entered = true
      return { text: 'keep my draft' }
    }
  )
  expect(entered).toBe(false)
  expect(result).toEqual({
    drop: 'Account host unavailable; reconnect or restart this native session.'
  })
})
