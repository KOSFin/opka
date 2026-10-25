export const FORK_TASK_TERMINAL_FIXTURE = `
const {spawnSync} = require('node:child_process')
const {writeFileSync, realpathSync} = require('node:fs')
const assert = require('node:assert/strict')
const cli = process.env.ORCA_CLI_COMMAND
const [expectedCli, expectedProfile] = process.argv.slice(2)
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
  const task = call('board').tasks.find(task => task.title === 'Packaged task smoke')
  assert.ok(task)
  const identity = ['--id', task.id, '--revision', task.revision]
  const attempt = call('claim', ...identity).attempt.id
  assert.equal(call('claim', ...identity).attempt.id, attempt)
  const args = [...identity, '--attempt', attempt]
  call('progress', ...args, '--checkpoint', 'Synthetic terminal fixture: next save report')
  writeFileSync('result.md', '# Packaged fixture result\\nNo model used. Terminal CLI lifecycle checked.\\n')
  const done = call('complete', ...args, '--checkpoint', 'Next: operator review', '--file', 'result.md')
  assert.equal(done.workflow.phase, 'review')
  assert.equal(done.workflow.attempts.length, 1)
  assert.ok(done.attempt.reportPath)
  writeFileSync('receipt.json', JSON.stringify({ok:true, phase:done.workflow.phase, reportPath:done.attempt.reportPath}))
} catch (error) {
  writeFileSync('receipt.json', JSON.stringify({ok:false, message:error.message, identityPresent: {
    handle:Boolean(process.env.ORCA_TERMINAL_HANDLE), pane:Boolean(process.env.ORCA_PANE_KEY),
    launch:Boolean(process.env.ORCA_AGENT_LAUNCH_TOKEN), session:Boolean(process.env.ORCA_AGENT_SESSION_ID)
  }}))
  process.exitCode=1
}
`
