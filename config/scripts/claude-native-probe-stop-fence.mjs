import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Adversarial fake title request stays in flight across the native public Stop hook. */
export class NativeClaudeProbeStopFence {
  active = new Set()
  events = []
  held = null
  heldOnce = false
  switched = false
  timer = null
  constructor(switchToB) {
    this.switchToB = switchToB
  }
  async install(config, root, port) {
    const hook = join(root, 'stop-hook.mjs')
    await writeFile(
      hook,
      `for await (const _ of process.stdin) {}\nawait fetch('http://127.0.0.1:${port}/probe-stop', { method: 'POST' })\n`,
      { mode: 0o600 }
    )
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(hook)}` }] }
          ]
        }
      }),
      { mode: 0o600 }
    )
  }
  observeInference(res) {
    this.active.add(res)
    const done = () => this.active.delete(res)
    res.once('finish', done)
    res.once('close', done)
  }
  holdTitle(parsed, body, respond) {
    if (
      this.heldOnce ||
      parsed.model === 'claude-sonnet-4-5' ||
      !body.includes('synthetic-first-turn') ||
      body.includes('synthetic-second-turn')
    ) {
      return false
    }
    this.heldOnce = true
    this.held = respond
    this.events.push({ event: 'title-held' })
    this.timer = setTimeout(() => this.release(false), 5000)
    return true
  }
  release(failure) {
    if (!this.held) {
      return
    }
    clearTimeout(this.timer)
    const respond = this.held
    this.held = null
    this.events.push({ event: failure ? 'late-a-401' : 'title-timeout-success' })
    respond(failure)
  }
  async handleStop(res) {
    this.events.push({
      event: 'native-stop',
      activeInference: this.active.size,
      heldTitle: Boolean(this.held)
    })
    if (!this.switched) {
      await this.switchToB()
      this.switched = true
      this.events.push({ event: 'facade-b-at-stop' })
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    if (this.held) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.release(true), 500)
    }
  }
  dispose() {
    clearTimeout(this.timer)
    this.release(false)
  }
}
