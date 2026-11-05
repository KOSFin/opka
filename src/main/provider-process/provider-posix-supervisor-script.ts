import { PROVIDER_SPAWN_FAILURE_MARKER } from './provider-spawn-failure-report'

/** The report channel is private to this supervisor; the provider inherits a /dev/null shield. */
export function buildPosixProviderSupervisorScript({
  groupReapTimeoutMs,
  outputDrainTimeoutMs
}: {
  groupReapTimeoutMs: number
  outputDrainTimeoutMs: number
}): string {
  return `
(() => {
const { spawn } = require('node:child_process')
const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
// The provider's own argv, after this script's '--'.
const [providerCommand, ...providerArgs] = process.argv.slice(1)
// A detached supervisor is reparented when its owner exits. The new parent may
// be PID 1 or a platform subreaper, so any other parent means no live owner.
const ownerGone = () => process.ppid !== spec.ownerPid
// Registered before the spawn, so a stop that lands while the provider starts still reaps it.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stopProviderGroup(signal))
// Orca can die before this runs; spawning then would start a provider nothing watches.
if (ownerGone()) process.exit(1)
const childEnv = { ...process.env, ...spec.nodeEnv }
delete childEnv.ORCA_PROVIDER_SUPERVISOR_SPEC
delete childEnv.ELECTRON_RUN_AS_NODE
// The owner sees only this pid's exit; this marked last stderr line says the provider never started.
const exitWithSpawnFailure = (error, thrown) => {
  const report = { thrown, code: (error && error.code) || 'UNKNOWN', message: String(error && error.message) }
  try { require('node:fs').writeSync(2, ${JSON.stringify(PROVIDER_SPAWN_FAILURE_MARKER)} + JSON.stringify(report) + '\\n') } catch {}
  if (reports && (!child || child.pid === undefined)) {
    const finish = () => process.exit(127)
    setTimeout(finish, 1000).unref()
    try { process.send({ providerNotStarted: true }, finish); return } catch {}
  }
  process.exit(127)
}
// Orca opens the report channel only when it will keep the group's identity. Linux children
// inherit its fd, so /dev/null takes that slot and only this pid holds the channel.
const reports = typeof process.send === 'function'
const reportShield = reports ? require('node:fs').openSync('/dev/null', 'r') : null
let child
try {
  child = spawn(providerCommand, providerArgs, {
    cwd: spec.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe', ...(reportShield === null ? [] : [reportShield])],
    detached: true
  })
} catch (error) {
  // Node throws most spawn failures (ENOEXEC, ENOTDIR, ...) rather than emitting them.
  return exitWithSpawnFailure(error, true)
}
// With the group's identity in Orca, a SIGKILL of this pid cannot orphan the group.
if (reports) {
  try { require('node:fs').closeSync(reportShield) } catch {}
  const disconnect = () => { try { process.disconnect() } catch {} }
  try {
    if (child.pid) process.send({ pgid: child.pid }, disconnect)
  } catch { disconnect() }
}
let timer
let ownerShutdownTimer
let settling = false
let providerExited = false
const providerGroupExists = () => {
  if (!child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code !== 'ESRCH')
  }
}
const waitForProviderGroupExit = async (timeoutMs, untilProviderExits = false) => {
  const deadline = Date.now() + timeoutMs
  while (providerGroupExists()) {
    if (Date.now() >= deadline || (untilProviderExits && providerExited)) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}
const reapOwnedProviderGroup = async () => {
  if (!child.pid) return false
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
    if (error && error.code !== 'ESRCH') return false
  }
  return waitForProviderGroupExit(${groupReapTimeoutMs})
}
const finishWithProviderOutcome = (code, signal) => {
  if (!signal) return process.exit(code ?? 1)
  // Re-raise with the default action; this supervisor's own handler would swallow it.
  process.removeAllListeners(signal)
  process.kill(process.pid, signal)
}
// Every stop is the same: SIGTERM the group, SIGKILL it after its grace, and exit only once it is
// gone. Whoever stops this pid judges the provider by it, so a dead supervisor means a dead group.
const stopProviderGroup = (receivedSignal) => {
  if (settling) return
  settling = true
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  // A one-shot's helpers die with it once it has exited; a session's keep the grace to clean up.
  void waitForProviderGroupExit(spec.sigtermGraceMs, spec.lifetime === 'one-shot')
    .then((exited) => exited || reapOwnedProviderGroup())
    .then((reaped) => {
      if (!reaped) return process.exit(1)
      finishWithProviderOutcome(137, receivedSignal)
    })
}
const scheduleOwnerShutdown = () => {
  if (settling || ownerShutdownTimer) return
  // A normal close ends the provider's stdin first; allow it to flush and
  // exit before forcing the group, while still bounding an orphaned child.
  ownerShutdownTimer = setTimeout(() => stopProviderGroup(null), spec.stdinEndGraceMs)
  ownerShutdownTimer.unref()
}
// A one-shot's stdin end is the end of its request, not a stop; only its owner's death stops it.
if (spec.lifetime !== 'one-shot') {
  process.stdin.once('end', scheduleOwnerShutdown)
  process.stdin.once('close', scheduleOwnerShutdown)
}
// A spawn that failed outright (EMFILE, ENFILE) has no pid and no pipes; its 'error' reports it.
if (child.pid) {
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  // A dead owner's stdout pipe raises EPIPE; unhandled, it would end this pid before the group.
  for (const stream of [process.stdin, process.stdout, process.stderr, child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => {})
  }
}
// Exit can land before the provider's last output is relayed; a one-shot's answer is that output.
const drainProviderOutput = () => {
  const ended = (stream) => stream.readableEnded || stream.destroyed ? null : new Promise((resolve) => {
    stream.once('end', resolve)
    stream.once('close', resolve)
  })
  const flushed = (stream) => new Promise((resolve) => stream.write('', resolve))
  const drained = Promise.all([child.stdout, child.stderr].map(ended))
    .then(() => Promise.all([process.stdout, process.stderr].map(flushed)))
  return Promise.race([drained, new Promise((resolve) => setTimeout(resolve, ${outputDrainTimeoutMs}))])
}
const reapProviderExit = async (code, signal) => {
  if (settling) return
  settling = true
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  if (!(await reapOwnedProviderGroup())) return process.exit(1)
  await drainProviderOutput()
  finishWithProviderOutcome(code, signal)
}
// An owner that is gone gets the close its owner would have asked for, made here on its behalf.
timer = setInterval(() => {
  if (!ownerGone()) return
  clearInterval(timer)
  process.stdin.unpipe(child.stdin)
  try { child.stdin.end() } catch {}
  // A one-shot's stdin end was its request, so only a stop is left to ask for.
  if (spec.lifetime === 'one-shot' || spec.closeRequest !== 'stdin-end') return stopProviderGroup(null)
  scheduleOwnerShutdown()
}, 100)
timer.unref()
child.once('error', (error) => {
  clearInterval(timer)
  exitWithSpawnFailure(error, false)
})
child.once('exit', (code, signal) => {
  providerExited = true
  void reapProviderExit(code, signal)
})

})()
`
}
