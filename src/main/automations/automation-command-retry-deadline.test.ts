import { afterEach, describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { AUTOMATION_CGROUP_SUPERVISOR_SOURCE } from './automation-cgroup-supervisor-source'
import { executeLinuxCgroupAutomationCommand } from './automation-linux-cgroup-command'
import { commandRetryFixture, RETRY_NOW } from './automation-command-retry-fixture'
import { writeDurableJson } from './automation-durable-receipt-write'
import { spawnProcess } from '@orca/process-host'

const memory = vi.hoisted(() => new Map<string, string>())
vi.mock('node:fs', () => ({
  existsSync: (p: string) => memory.has(p),
  mkdirSync: vi.fn(),
  readFileSync: (p: string) => {
    if (p === '/proc/42/cgroup') {
      return '0::/fixture/command'
    }
    if (p === '/proc/42/stat') {
      return `42 (child) ${Array(20).fill('500').join(' ')}`
    }
    const value = memory.get(p)
    if (value === undefined) {
      throw new Error(`Missing test receipt ${p}`)
    }
    return value
  }
}))
vi.mock('../daemon/daemon-cgroup-scope', () => ({
  isDurableDaemonScopeSupported: () => true,
  userManagerEnv: () => ({})
}))
vi.mock('./automation-durable-receipt-write', () => ({
  writeDurableJson: vi.fn((p: string, value: unknown) => memory.set(p, JSON.stringify(value))),
  writeDurableText: vi.fn()
}))
vi.mock('@orca/process-host', () => ({
  spawnProcess: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }))
}))
vi.mock('./automation-linux-cgroup-lifecycle', () => ({
  isAutomationCgroupEmpty: () => true,
  releaseLinuxCgroupAutomationProcess: vi.fn()
}))
vi.mock('./automation-cgroup-command-receipt', () => ({
  verifyAutomationCommandReceipt: (_: unknown, value: unknown) => value
}))

afterEach(() => {
  vi.useRealTimers()
  memory.clear()
  vi.clearAllMocks()
})

function executorInput() {
  const input = commandRetryFixture()
  const claim = { ...input.claim, attempt: 2 }
  if (!claim.processIntent) {
    throw new Error('Missing intent')
  }
  const directory = claim.processIntent.receiptDirectory
  const receipt = {
    acquisitionId: claim.acquisitionId,
    unitName: claim.processIntent.unitName,
    childCgroupPath: `/sys/fs/cgroup/${claim.processIntent.unitName}/command`,
    blockedChildPid: 42,
    blockedChildStartTime: '500'
  }
  memory.set(`${directory}/receipt.json`, JSON.stringify(receipt))
  memory.set(
    `${directory}/empty.json`,
    JSON.stringify({ acquisitionId: claim.acquisitionId, childCgroupPath: receipt.childCgroupPath })
  )
  memory.set(
    `${directory}/root.json`,
    JSON.stringify({
      exitCode: 0,
      error: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false
    })
  )
  return {
    definition: input.definition,
    claim,
    cwd: '/synthetic/folder',
    resolvedExecutable: '/bin/true',
    bindReceipt: vi.fn(async () => {}),
    persistExitProof: vi.fn(async () => {}),
    mayReleaseGate: vi.fn(() => true)
  }
}

describe.skipIf(process.platform !== 'linux')('retry original lifecycle deadline', () => {
  it.each([0, 89_000])(
    'persists the lesser command/lifecycle deadline after %ims elapsed',
    async (elapsed) => {
      vi.useFakeTimers()
      vi.setSystemTime(RETRY_NOW + elapsed)
      const input = executorInput()
      expect((await executeLinuxCgroupAutomationCommand(input)).verdict).toBe('exited')
      expect(writeDurableJson).toHaveBeenCalledWith(
        expect.stringContaining('spec.json'),
        expect.objectContaining({ deadlineAt: RETRY_NOW + Math.min(elapsed + 60_000, 90_000) })
      )
      expect(input.persistExitProof).toHaveBeenCalledOnce()
    }
  )

  it('starts no supervisor after deadline and does not release a gate when binding consumes the allowance', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(RETRY_NOW + 90_000)
    const input = executorInput()
    expect((await executeLinuxCgroupAutomationCommand(input)).verdict).toBe('unverifiable')
    expect(spawnProcess).not.toHaveBeenCalled()
    vi.setSystemTime(RETRY_NOW + 89_000)
    input.bindReceipt.mockImplementation(async () => {
      vi.setSystemTime(RETRY_NOW + 90_000)
    })
    expect((await executeLinuxCgroupAutomationCommand(input)).verdict).toBe('unverifiable')
    expect(writeDurableJson).not.toHaveBeenCalledWith(
      expect.stringContaining('gate.json'),
      expect.anything()
    )
  })

  it('includes startup time in the existing supervisor kill timer', async () => {
    const input = commandRetryFixture()
    const blocked = new EventEmitter()
    const writes: string[] = []
    const timers: number[] = []
    const spec = {
      acquisitionId: input.claim.acquisitionId,
      unitName: input.claim.processIntent?.unitName,
      childName: 'command',
      timeoutMs: 60_000,
      deadlineAt: RETRY_NOW + 1000
    }
    const fs = {
      readFileSync: (p: string) =>
        p.endsWith('spec.json')
          ? JSON.stringify(spec)
          : p === '/proc/self/cgroup'
            ? `0::/${spec.unitName}`
            : p.endsWith('/stat')
              ? `42 (child) ${Array(20).fill('500').join(' ')}`
              : 'populated 0',
      mkdirSync: vi.fn(),
      writeFileSync: (p: string) => writes.push(p),
      openSync: () => 1,
      fsyncSync: vi.fn(),
      closeSync: vi.fn(),
      renameSync: vi.fn(),
      existsSync: () => true,
      rmdirSync: vi.fn(),
      rmSync: vi.fn()
    }
    runInNewContext(AUTOMATION_CGROUP_SUPERVISOR_SOURCE, {
      require: (name: string) =>
        name === 'node:fs'
          ? fs
          : name === 'node:path'
            ? path
            : { spawn: () => Object.assign(blocked, { pid: 42 }) },
      process: { argv: ['', '', 'supervisor', '/receipt'], execPath: '/node', env: {} },
      __filename: '/supervisor.cjs',
      Date: { now: () => RETRY_NOW + 600 },
      setTimeout: (callback: () => void, delay: number) => {
        timers.push(delay)
        callback()
        return 1
      },
      clearTimeout: vi.fn()
    })
    expect(timers).toEqual([400])
    expect(writes).toContain(`/sys/fs/cgroup/${spec.unitName}/command/cgroup.kill`)
    blocked.emit('close')
    await Promise.resolve()
  })
})
