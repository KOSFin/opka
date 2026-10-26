export const FORK_TASK_TERMINAL_FIXTURE = `
const {spawnSync} = require('node:child_process')
const {writeFileSync, realpathSync, existsSync} = require('node:fs')
const assert = require('node:assert/strict')
const cli = process.env.ORCA_CLI_COMMAND
const [expectedCli, expectedProfile, mode, title = 'Packaged task smoke'] = process.argv.slice(2)
;(async () => {
try {
  assert.equal(realpathSync(cli), realpathSync(expectedCli))
  assert.equal(realpathSync(process.env.ORCA_USER_DATA_PATH), realpathSync(expectedProfile))
  const call = (...args) => {
    const reply = spawnSync(cli, ['project-task', ...args, '--json'], {
      encoding:'utf8', timeout:15000, maxBuffer:1024*1024
    })
    if (reply.status !== 0) {
      throw new Error(args[0]+': '+reply.stdout.slice(0,2000)+reply.stderr.slice(0,2000))
    }
    const envelope = JSON.parse(reply.stdout)
    assert.equal(envelope.ok, true)
    return envelope.result
  }
  const task = call('board').tasks.find(task => task.title === title)
  assert.ok(task)
  const identity = ['--id', task.id, '--revision', task.revision]
  if (mode === 'compete') {
    assert.throws(() => call('claim', ...identity), /belongs to another chat/)
    writeFileSync('competitor.json', JSON.stringify({denied:true}))
    return
  }
  let attempt = call('claim', ...identity).attempt.id
  assert.equal(call('claim', ...identity).attempt.id, attempt)
  let args = [...identity, '--attempt', attempt]
  let expectedAttempts = 1
  call('progress', ...args, '--checkpoint', 'Synthetic terminal fixture: next save report')
  if (mode === 'release') {
    const released = call('progress', ...args, '--checkpoint', 'Explicit handoff, no process stop', '--release')
    assert.equal(released.workflow.phase, 'ready')
    const previous = attempt
    const priorArgs = args
    attempt = call('claim', ...identity).attempt.id
    assert.notEqual(attempt, previous)
    assert.throws(() => call('progress', ...priorArgs, '--checkpoint', 'Stale attempt must not write'))
    args = [...identity, '--attempt', attempt]
    expectedAttempts = 2
  }
  if (mode === 'pause') {
    writeFileSync('claimed.json', JSON.stringify({attempt, claimed:true}))
    const deadline = Date.now() + 60000
    while (!existsSync('continue.json')) {
      if (Date.now() > deadline) throw new Error('Synthetic restart barrier timed out')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(call('claim', ...identity).attempt.id, attempt)
    call('progress', ...args, '--checkpoint', 'Same terminal continued after owning runtime restart')
  }
  writeFileSync('result.md', '# Packaged fixture result\\nNo model used. Terminal CLI lifecycle checked. sum.mjs fixture.\\n')
  const done = call('complete', ...args, '--checkpoint', 'Next: operator review', '--file', 'result.md')
  assert.equal(done.workflow.phase, 'review')
  assert.equal(done.workflow.attempts.length, expectedAttempts)
  assert.ok(done.attempt.reportPath)
  writeFileSync('receipt.json', JSON.stringify({ok:true, phase:done.workflow.phase, reportPath:done.attempt.reportPath}))
} catch (error) {
  writeFileSync(mode === 'compete' ? 'competitor.json' : 'receipt.json', JSON.stringify({ok:false, message:error.message, identityPresent: {
    handle:Boolean(process.env.ORCA_TERMINAL_HANDLE), pane:Boolean(process.env.ORCA_PANE_KEY),
    launch:Boolean(process.env.ORCA_AGENT_LAUNCH_TOKEN), session:Boolean(process.env.ORCA_AGENT_SESSION_ID)
  }}))
  process.exitCode=1
}
})()
`

export const FORK_TASK_FILTERED_CODEX_FIXTURE = `
const {spawnSync} = require('node:child_process')
const assert = require('node:assert/strict')
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  console.log('Synthetic Codex command transport: --no-daemon')
  process.exit(0)
}
const env = Object.fromEntries(['HOME','PATH','TMPDIR','TEMP','USER','SHELL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
const positional = []
for (let i=0;i<args.length;i++) {
  if (args[i] === '--no-daemon') continue
  if (args[i] === '-c') {
    const setting = args[++i]
    assert.ok(!/TOKEN|SECRET|PASSWORD/.test(setting))
    const match = /^shell_environment_policy\\.set\\.([A-Z_]+)='([^']*)'$/.exec(setting)
    if (match) env[match[1]] = match[2]
  } else positional.push(args[i])
}
assert.equal(env.ORCA_AGENT_LAUNCH_TOKEN, undefined)
const result = spawnSync(process.execPath, positional, {env, stdio:'inherit'})
process.exit(result.status ?? 1)
`
