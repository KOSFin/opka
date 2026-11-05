import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { URL } from 'node:url'
import { runProcess } from '@orca/process-host'
import { prepareDarwinSecurityDiagnostic } from './claude-native-darwin-security-shim.mjs'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'
import {
  forwardSecurityDiagnostic,
  readSecurityDiagnosticTrace,
  SECURITY_TRACE_SLOT_BYTES,
  SECURITY_TRACE_SLOTS
} from './claude-native-darwin-security-shim-runner.mjs'

test(
  'diagnostic installer refuses outside isolated Darwin CI before touching a path',
  {
    skip: isDarwinNativeProbeCi()
  },
  async () => {
    await assert.rejects(prepareDarwinSecurityDiagnostic(undefined), /isolated Darwin CI/)
  }
)
test('fake target receives unchanged argv/input and forwards byte channels plus exit code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opka-security-forward-'))
  try {
    const traceDirectory = join(root, 'trace')
    await mkdir(traceDirectory)
    const target = join(root, 'fake.mjs')
    await writeFile(
      target,
      `import process from 'node:process';
process.stdout.write(JSON.stringify(process.argv.slice(2))+'\\n');
process.stdin.pipe(process.stdout);
process.stderr.write(new Uint8Array([255,0,128]));
process.exitCode=7;`
    )
    const args = [target, 'find-generic-password', 'synthetic;$`" argument']
    const entry = join(root, 'entry.mjs')
    await writeFile(
      entry,
      `import process from 'node:process';
import {forwardSecurityDiagnostic} from ${JSON.stringify(new URL('./claude-native-darwin-security-shim-runner.mjs', import.meta.url).href)};
const result=await forwardSecurityDiagnostic(${JSON.stringify({ program: process.execPath, args, traceDirectory })});
process.exitCode=result.code??127;`
    )
    const stderr = []
    const input = '\u0000synthetic input\n'
    const result = await runProcess({
      program: process.execPath,
      args: [entry],
      input,
      captureStdoutAsBytes: true,
      onStderr: (chunk) => stderr.push(Buffer.from(chunk)),
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      terminationBarrier: true
    })
    assert.equal(result.code, 7)
    assert.equal(result.timedOut, false)
    assert.deepEqual(result.stdoutBytes, Buffer.from(`${JSON.stringify(args.slice(1))}\n${input}`))
    assert.deepEqual(Buffer.concat(stderr), Buffer.from([255, 0, 128]))
    const trace = await readSecurityDiagnosticTrace(traceDirectory)
    assert.deepEqual(trace.records, [
      { operation: 'other', started: true, finished: true, code: 7 }
    ])
    assert.equal(JSON.stringify(trace).includes('synthetic'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('concurrent diagnostic claims and overflow remain within sixteen fixed 128-byte slots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opka-security-slots-'))
  try {
    const invoke = () =>
      forwardSecurityDiagnostic({
        program: process.execPath,
        args: ['-e', ''],
        traceDirectory: root
      })
    await Promise.all([invoke(), invoke()])
    for (let index = 0; index < SECURITY_TRACE_SLOTS; index++) {
      assert.equal((await invoke()).code, 0)
    }
    const files = await readdir(root)
    assert.equal(files.length, SECURITY_TRACE_SLOTS)
    let total = 0
    for (const name of files) {
      const size = (await stat(join(root, name))).size
      assert.ok(size <= SECURITY_TRACE_SLOT_BYTES)
      total += size
    }
    assert.ok(total <= 2048)
    const trace = await readSecurityDiagnosticTrace(root)
    assert.equal(trace.capacityReached, true)
    assert.equal(trace.unverifiable, false)
    assert.equal(
      trace.records.every((record) => record.finished && record.code === 0),
      true
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('malformed diagnostic data is reported unknown without publishing its contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opka-security-unknown-'))
  try {
    await writeFile(join(root, '0.json'), 'synthetic-secret'.repeat(20))
    const result = await readSecurityDiagnosticTrace(root)
    assert.equal(result.unverifiable, true)
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
