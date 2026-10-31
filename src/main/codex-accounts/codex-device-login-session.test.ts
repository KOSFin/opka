import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
import { runCodexLoginSession, type CodexLoginSpawnRequest } from './codex-login-session'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'device-login-'))
  roots.push(home)
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true
  })
  const spawn = vi.fn((_request: CodexLoginSpawnRequest) => child)
  const onPrompt = vi.fn()
  const onAuthUrl = vi.fn()
  const kill = vi.fn()
  const controller = new AbortController()
  const done = runCodexLoginSession(home, {
    wslCommand: 'wsl.exe',
    spawn,
    killProcessTree: kill,
    onAuthUrl,
    setCancel: vi.fn(),
    deviceAuth: { onPrompt, signal: controller.signal }
  })
  return { child, spawn, onPrompt, onAuthUrl, kill, controller, done }
}
const prompt =
  'https://auth.openai.com/codex/device\n2. Enter this one-time code (expires in 15 minutes)\nAB12-CDE34\n'

describe('host device login lifecycle', () => {
  it.each(['stdout', 'stderr'] as const)(
    'captures the prompt from %s without publishing an OAuth callback',
    async (stream) => {
      const h = setup()
      expect(h.spawn.mock.calls[0]?.[0].args).toContain('--device-auth')
      h.child[stream].write(prompt.slice(0, 40))
      expect(h.onPrompt).not.toHaveBeenCalled()
      h.child[stream].write(prompt.slice(40))
      expect(h.onPrompt).toHaveBeenCalledExactlyOnceWith({
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'AB12-CDE34'
      })
      expect(h.onAuthUrl).not.toHaveBeenCalled()
      h.child.emit('close', 0)
      await h.done
    }
  )
  it('cancels the owned child and removes stream listeners', async () => {
    const h = setup()
    const rejection = expect(h.done).rejects.toThrow(/cancelled/i)
    h.controller.abort()
    await rejection
    expect(h.kill).toHaveBeenCalledExactlyOnceWith(h.child, null)
    expect(h.child.stdout.listenerCount('data')).toBe(0)
    expect(h.child.stderr.listenerCount('data')).toBe(0)
  })
  it('does not put a printed device code into failure messages', async () => {
    const h = setup()
    const rejection = expect(h.done).rejects.toThrow('OpenAI rejected sign-in (403)')
    h.child.stderr.write(`${prompt}\n403 Forbidden token=private-token`)
    h.child.emit('close', 1)
    await rejection
    await expect(h.done).rejects.not.toThrow('private-token')
    await expect(h.done).rejects.not.toThrow('AB12-CDE34')
  })
})
