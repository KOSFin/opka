import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClaudeNativeHookPhase } from '../../src/main/claude-accounts/claude-native-hook-phase.ts'

export class NativeClaudeProbeLimitFailover {
  events = []
  nonce = randomUUID()
  failureWakes = 0
  freshWakes = 0
  constructor(mode, switchAccount) {
    this.mode = mode
    this.switchAccount = switchAccount
    if (mode === 'signed-two-phase') {
      this.phase = createClaudeNativeHookPhase({
        readOwner: () => 'synthetic-owned-native-session',
        readPolicy: () => 'synthetic-policy-v1',
        readBoundary: () => ({ canSwitch: () => true, onBoundaryAccepted: () => {} }),
        readCompletedSuccessfully: () => false,
        select: async () => ({ accountId: 'synthetic-B', snapshot: {} }),
        publish: async (_snapshot, canSwitch) => {
          if (!canSwitch()) {
            throw new Error('Synthetic boundary expired')
          }
          await this.switchAccount()
        }
      })
    }
  }
  async handleHook(requestPath, response, payload) {
    if (!requestPath?.startsWith('/probe-limit-')) {
      return false
    }
    if (payload.nonce !== this.nonce) {
      response.writeHead(403).end('{}')
      return true
    }
    if (this.phase) {
      let verdict = {}
      if (requestPath === '/probe-limit-admit') {
        this.events.push('UserPromptSubmit')
        const result = await this.phase.prompt(payload.promptId, payload.marker ?? '', () => true)
        if (result === 'block') {
          this.events.push('stale-native-turn-blocked')
          verdict = { block: true }
        }
      } else if (requestPath === '/probe-limit-failure') {
        this.events.push('StopFailure')
        const id = await this.phase.failure(payload.promptId, 'synthetic-A')
        const wake = id && this.phase.claimWake(id, 1)
        verdict = { wake: wake?.marker }
      } else if (requestPath === '/probe-limit-rewake') {
        const wake = await this.phase.freshWake(payload.marker ?? '')
        if (wake) {
          this.events.push('fresh-native-wake')
        }
        verdict = { wake: wake?.marker }
      }
      response.writeHead(200).end(JSON.stringify(verdict))
      return true
    }
    if (requestPath === '/probe-limit-rewake') {
      if (this.failed && !this.blockedPrompt) {
        await new Promise((done) => setTimeout(done, 300))
      }
      const wake =
        this.blockedPrompt && payload.promptId === this.blockedPrompt && this.freshWakes++ === 0
      if (wake) {
        this.events.push('fresh-native-wake')
        await new Promise((done) => setTimeout(done, 300))
      }
      response.writeHead(200).end(JSON.stringify({ wake: Boolean(wake) }))
      return true
    }
    if (requestPath === '/probe-limit-admit') {
      this.events.push('UserPromptSubmit')
      if (this.failed && this.mode === 'two-phase-rewake' && !this.blockedPrompt) {
        if (typeof payload.promptId !== 'string' || !payload.promptId) {
          throw new Error('Native prompt identity absent')
        }
        this.blockedPrompt = payload.promptId
        await this.switchAccount()
        this.events.push('stale-native-turn-blocked')
        response.writeHead(200).end('{"block":true}')
        return true
      }
      if (this.failed && this.mode !== 'two-phase-rewake') {
        await this.switchAccount()
      }
      response.writeHead(200).end('{}')
      return true
    }
    if (requestPath !== '/probe-limit-failure') {
      return false
    }
    this.events.push('StopFailure')
    this.failed = true
    if (this.mode !== 'gated-rewake' && this.mode !== 'two-phase-rewake') {
      await this.switchAccount()
    }
    response.writeHead(200).end(JSON.stringify({ wake: this.failureWakes++ === 0 }))
    return true
  }
  async handleMessage(response, identity, body) {
    if (identity !== 'A' || !body.includes('synthetic-first-turn')) {
      return false
    }
    this.events.push('main-429-A')
    if (this.mode === 'retry-swap' && this.events.length === 1) {
      await this.switchAccount()
    }
    response
      .writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '1',
        ...(this.mode !== 'retry-swap' ? { 'x-should-retry': 'false' } : {})
      })
      .end(
        '{"type":"error","error":{"type":"rate_limit_error","message":"Synthetic account quota exhausted"}}'
      )
    return true
  }
  async install(config, root, port) {
    if (this.mode === 'retry-swap') {
      return
    }
    const script = join(root, 'synthetic-limit-hook.mjs')
    await writeFile(
      script,
      `
import { request } from 'node:http'
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1048576)throw new Error('Synthetic hook input overflow')}
const native=JSON.parse(input||'{}')
const req = request({hostname:'127.0.0.1',port:${port},path:process.argv[2],method:'POST'}, res => {
  let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{
    const verdict=JSON.parse(body||'{}')
    if(verdict.block)process.stdout.write(JSON.stringify({decision:'block',reason:'Waiting for a fresh native account context.',suppressOutput:true,suppressOriginalPrompt:true}))
    else if(verdict.wake&&process.argv[3]==='rewake'){process.stderr.write(typeof verdict.wake==='string'?verdict.wake:'Account selection updated. Continue the interrupted task.');process.exitCode=2}
  })
})
req.on('error',()=>{process.exitCode=1})
req.setTimeout(5000,()=>req.destroy())
req.end(JSON.stringify({nonce:${JSON.stringify(this.nonce)},promptId:native.prompt_id,marker:native.prompt?.match(/<opka-native-wake:v1:[a-f0-9-]{36}:[12]:[a-f0-9]{64}>/)?.[0]}))
`,
      { mode: 0o600 }
    )
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({
        hooks: {
          StopFailure: [
            {
              matcher: 'rate_limit',
              hooks: [
                {
                  type: 'command',
                  command: process.execPath,
                  args: [script, '/probe-limit-failure', 'rewake'],
                  asyncRewake: true,
                  timeout: 8
                }
              ]
            }
          ],
          ...(['gated-rewake', 'two-phase-rewake', 'signed-two-phase'].includes(this.mode)
            ? {
                UserPromptSubmit: [
                  {
                    hooks: [
                      {
                        type: 'command',
                        command: process.execPath,
                        args: [script, '/probe-limit-admit'],
                        timeout: 8
                      },
                      ...(['two-phase-rewake', 'signed-two-phase'].includes(this.mode)
                        ? [
                            {
                              type: 'command',
                              command: process.execPath,
                              args: [script, '/probe-limit-rewake', 'rewake'],
                              asyncRewake: true,
                              timeout: 8
                            }
                          ]
                        : [])
                    ]
                  }
                ]
              }
            : {})
        }
      }),
      { mode: 0o600 }
    )
  }
}
