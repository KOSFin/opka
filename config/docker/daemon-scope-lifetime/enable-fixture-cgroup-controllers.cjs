const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const pidOneCgroup = fs
  .readFileSync('/proc/1/cgroup', 'utf8')
  .split('\n')
  .find((line) => line.startsWith('0::'))
assert.ok(pidOneCgroup, 'unified cgroup path for container PID 1 required')
const pidOnePath = pidOneCgroup.slice(3)
const parentPath = pidOnePath.match(/^(\/system\.slice\/docker-[a-f0-9]{64}\.scope)(?:\/|$)/)?.[1]
assert.ok(parentPath, 'Docker systemd scope for container PID 1 required')
const parent = path.join('/sys/fs/cgroup', parentPath)
assert.ok(fs.statSync(parent).isDirectory(), 'container parent cgroup missing')
const controllers = new Set(
  fs.readFileSync(path.join(parent, 'cgroup.controllers'), 'utf8').trim().split(/\s+/)
)
const subtreeFile = path.join(parent, 'cgroup.subtree_control')
const enabled = () => new Set(fs.readFileSync(subtreeFile, 'utf8').trim().split(/\s+/))
const required = ['memory', 'pids']
for (const controller of required) {
  assert.ok(controllers.has(controller), `${controller} controller unavailable at container parent`)
}
const missing = required.filter((controller) => !enabled().has(controller))
if (missing.length > 0) {
  assert.equal(
    fs.readFileSync(path.join(parent, 'cgroup.procs'), 'utf8').trim(),
    '',
    'container parent has internal processes'
  )
  fs.writeFileSync(subtreeFile, missing.map((controller) => `+${controller}`).join(' '))
}
for (const controller of required) {
  assert.ok(
    enabled().has(controller),
    `${controller} controller not delegated to container children`
  )
}
console.log(
  JSON.stringify({
    oracle: 'fixture-container-parent-controllers-enabled',
    parentPath,
    controllers: required
  })
)
