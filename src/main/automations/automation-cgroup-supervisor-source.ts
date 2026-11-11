/** Runs only inside a delegated Linux user scope. The command child waits for a durable host gate. */
export const AUTOMATION_CGROUP_SUPERVISOR_SOURCE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const directory = process.argv[3];
const mode = process.argv[2];
const spec = JSON.parse(fs.readFileSync(path.join(directory, 'spec.json'), 'utf8'));
const file = (name) => path.join(directory, name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function atomic(name, value) {
  const temporary = file(name + '.tmp');
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file(name));
  const parent = fs.openSync(directory, 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function procStart(pid) {
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
function ownCgroup() {
  const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((entry) => entry.startsWith('0::'));
  if (!line) throw new Error('cgroup_v2_required');
  const relative = line.slice(3);
  if (path.basename(relative) !== spec.unitName) throw new Error('scope_identity_mismatch');
  return path.join('/sys/fs/cgroup', relative);
}
async function child() {
  const started = Date.now();
  while (!fs.existsSync(file('gate.json'))) {
    if (Date.now() - started > 15000) process.exit(90);
    await sleep(25);
  }
  const gate = JSON.parse(fs.readFileSync(file('gate.json'), 'utf8'));
  if (gate.acquisitionId !== spec.acquisitionId) process.exit(91);
  const command = spec.command;
  const program = command.kind === 'program' ? command.executable : command.interpreter || (command.language === 'shell' ? '/bin/sh' : 'python3');
  const args = command.kind === 'program' ? command.argv : [file(command.language === 'shell' ? 'command.sh' : 'command.py')];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let stdout = '', stderr = '', stdoutTruncated = false, stderrTruncated = false;
  const append = (value, chunk) => {
    const remaining = 16380 - Buffer.byteLength(value);
    return remaining > 0 ? value + chunk.subarray(0, remaining).toString('utf8') : value;
  };
  let root;
  try { root = spawn(program, args, { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { atomic('root.json', { exitCode: null, error: String(error), stdout, stderr, stdoutTruncated, stderrTruncated }); return; }
  root.stdout.on('data', (chunk) => {
    stdoutTruncated ||= Buffer.byteLength(stdout) + chunk.length > 16380;
    stdout = append(stdout, chunk);
  });
  root.stderr.on('data', (chunk) => {
    stderrTruncated ||= Buffer.byteLength(stderr) + chunk.length > 16380;
    stderr = append(stderr, chunk);
  });
  const result = await new Promise((resolve) => {
    root.once('error', (error) => resolve({ exitCode: null, error: String(error) }));
    root.once('close', (code, signal) => resolve({ exitCode: code, error: signal ? String(signal) : null }));
  });
  atomic('root.json', { ...result, stdout, stderr, stdoutTruncated, stderrTruncated });
}
async function supervisor() {
  const parentCgroup = ownCgroup();
  const childCgroup = path.join(parentCgroup, 'command');
  fs.mkdirSync(childCgroup);
  const blocked = spawn(process.execPath, [__filename, 'child', directory], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore'
  });
  if (!blocked.pid) throw new Error('blocked_child_spawn_failed');
  fs.writeFileSync(path.join(childCgroup, 'cgroup.procs'), String(blocked.pid));
  atomic('receipt.json', {
    acquisitionId: spec.acquisitionId,
    unitName: spec.unitName,
    childCgroupPath: childCgroup,
    blockedChildPid: blocked.pid,
    blockedChildStartTime: procStart(blocked.pid)
  });
  const timeout = setTimeout(() => {
    try { fs.writeFileSync(path.join(childCgroup, 'cgroup.kill'), '1'); } catch {}
    atomic('timeout.json', { timedOut: true });
  }, spec.timeoutMs + 15000);
  await new Promise((resolve) => blocked.once('close', resolve));
  while (!/^populated 0$/m.test(fs.readFileSync(path.join(childCgroup, 'cgroup.events'), 'utf8'))) {
    await sleep(100);
  }
  clearTimeout(timeout);
  atomic('empty.json', { acquisitionId: spec.acquisitionId, childCgroupPath: childCgroup });
  while (!fs.existsSync(file('release.json'))) await sleep(1000);
  fs.rmdirSync(childCgroup);
  for (const name of [
    'spec.json', 'supervisor.cjs', 'command.sh', 'command.py', 'receipt.json', 'gate.json', 'root.json',
    'empty.json', 'timeout.json', 'release.json', 'supervisor-error.json'
  ]) fs.rmSync(file(name), { force: true });
  fs.rmdirSync(directory);
}
(mode === 'child' ? child() : supervisor()).catch((error) => {
  try { atomic('supervisor-error.json', { error: String(error) }); } catch {}
  process.exitCode = 1;
});
`
