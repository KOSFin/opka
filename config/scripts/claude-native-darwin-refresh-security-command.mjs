import { runProcess } from '@orca/process-host'

/** ProcessResult has no exit-proof field; only the host termination callback supplies it. */
export async function runDarwinRefreshSecurityCommand(args, run = runProcess) {
  let terminationObserved = false
  const result = await run({
    program: '/usr/bin/security',
    args,
    timeoutMs: 3000,
    maxOutputBytes: 256,
    terminationBarrier: true,
    onChildTerminated() {
      terminationObserved = true
    }
  })
  return { result, terminationObserved }
}
