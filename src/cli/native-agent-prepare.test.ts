import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { terminalTaskCallerPath } from '../shared/terminal-task-caller-file'
import { nativeAgentStartupParentContext, prepareNativeAgentExec } from './native-agent-prepare'
import { expect, it, vi } from 'vitest'
import { RuntimeClientError, type RuntimeClient } from './runtime-client'
import { NativeCliAccountLaunchV2Params } from '../shared/native-cli-account-launch'
import { isPrivateNativeCliRpc } from '../shared/native-cli-private-rpc'
const params = {
  provider: 'codex' as const,
  launchId: '12345678-1234-4234-8234-123456789012',
  parentTerminal: {
    terminalHandle: 'term_owned',
    paneKey: 'tab:leaf',
    terminalTaskProof: 'a'.repeat(64)
  }
}
function client(call: ReturnType<typeof vi.fn>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only call is used; the mock supplies that exact promise interface.
  return { call } as Pick<RuntimeClient, 'call'>
}
it('uses strict private V2 with injected proof and token', async () => {
  const call = vi.fn().mockResolvedValue({ result: {} })
  await prepareNativeAgentExec(client(call), params, 'synthetic')
  const request = call.mock.calls[0][1]
  expect(call.mock.calls[0][0]).toBe('accounts.prepareNativeCliLaunchV2')
  expect(isPrivateNativeCliRpc(call.mock.calls[0][0])).toBe(true)
  expect(NativeCliAccountLaunchV2Params.safeParse(request).success).toBe(true)
  expect(NativeCliAccountLaunchV2Params.safeParse({ ...request, target: 'other' }).success).toBe(
    false
  )
  expect(
    NativeCliAccountLaunchV2Params.safeParse({
      ...request,
      startup: { version: 1, launchToken: 'x', reason: 'forged' }
    }).success
  ).toBe(false)
})
it.each(['timeout', 'connection_lost', 'native_cli_config_conflict'])(
  'never retries ambiguous/admitted %s',
  async (code) => {
    const error = new RuntimeClientError(code, 'synthetic')
    const call = vi.fn().mockRejectedValue(error)
    await expect(prepareNativeAgentExec(client(call), params, 'synthetic')).rejects.toBe(error)
    expect(call).toHaveBeenCalledTimes(1)
  }
)
it('falls back once only for pre-dispatch method_not_found', async () => {
  const call = vi
    .fn()
    .mockRejectedValueOnce(new RuntimeClientError('method_not_found', 'synthetic'))
    .mockResolvedValueOnce({ result: {} })
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    await prepareNativeAgentExec(client(call), params, 'synthetic')
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'accounts.prepareNativeCliLaunchV2',
      'accounts.prepareNativeCliLaunch'
    ])
    expect(call.mock.calls[1][1]).not.toHaveProperty('startup')
  } finally {
    stderr.mockRestore()
  }
})
it('keeps ordinary no-token CLI on V1', async () => {
  const call = vi.fn().mockResolvedValue({ result: {} })
  await prepareNativeAgentExec(client(call), params, '')
  expect(call.mock.calls[0][0]).toBe('accounts.prepareNativeCliLaunch')
})

it('waits for host registration to seal an injected placeholder proof', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opka-wrapper-proof-'))
  const path = terminalTaskCallerPath(root, 'pty-synthetic')
  mkdirSync(join(root, 'terminal-task-callers'))
  const record = { schema: 1, proof: 'a'.repeat(64) }
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 })
  const timer = setTimeout(
    () =>
      writeFileSync(
        path,
        JSON.stringify({
          ...record,
          identity: {
            terminalHandle: 'term_synthetic',
            paneKey: 'tab_fixture:77777777-7777-4777-8777-777777777777',
            worktreeId: 'folder:synthetic',
            processIncarnation: 'pty-synthetic:raw'
          }
        }),
        { mode: 0o600 }
      ),
    30
  )
  try {
    const context = await nativeAgentStartupParentContext({
      ORCA_USER_DATA_PATH: root,
      ORCA_TERMINAL_TASK_CALLER_FILE: path,
      ORCA_AGENT_LAUNCH_TOKEN: 'synthetic'
    })
    expect(context.parentTerminal?.terminalTaskProof).toBe(record.proof)
  } finally {
    clearTimeout(timer)
    rmSync(root, { recursive: true, force: true })
  }
})
