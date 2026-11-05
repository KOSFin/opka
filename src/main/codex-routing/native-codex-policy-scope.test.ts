import { beforeEach, expect, it, vi } from 'vitest'
import { assertNativeCodexPolicyScope } from './native-codex-policy-scope'
const { inspect, run } = vi.hoisted(() => ({ inspect: vi.fn(), run: vi.fn() }))
vi.mock('node:fs/promises', () => ({ lstat: inspect }))
vi.mock('@orca/process-host', () => ({ runProcess: run }))
beforeEach(() => {
  inspect.mockReset().mockRejectedValue(Object.assign(new Error('absent'), { code: 'ENOENT' }))
  run.mockReset().mockResolvedValue({
    code: 0,
    stdout: '{"config":false,"requirements":false}',
    timedOut: false,
    outputTruncated: false
  })
})
it('checks Unix policy presence without reading any configuration values', async () => {
  await expect(assertNativeCodexPolicyScope('linux')).resolves.toBeUndefined()
  expect(inspect).toHaveBeenCalledTimes(3)
  expect(run).not.toHaveBeenCalled()
})
it.each(['config.toml', 'managed_config.toml', 'requirements.toml'])(
  'refuses existing system input %s',
  async (name) => {
    inspect.mockImplementation(async (path: string) => {
      if (path.endsWith(`/${name}`)) {
        return {}
      }
      throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    })
    await expect(assertNativeCodexPolicyScope('linux')).rejects.toThrow('requires review')
  }
)
it('refuses unknown system metadata instead of interpreting denied access as absence', async () => {
  inspect.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
  await expect(assertNativeCodexPolicyScope('linux')).rejects.toThrow('could not be verified')
})
it('asks CFPreferences only whether fixed policy keys are forced, never for their values', async () => {
  await expect(assertNativeCodexPolicyScope('darwin')).resolves.toBeUndefined()
  const request = run.mock.calls[0]?.[0]
  expect(request.program).toBe('/usr/bin/osascript')
  expect(request.args[3]).toContain('CFPreferencesAppValueIsForced')
  expect(request.args[3]).not.toContain('CFPreferencesCopyAppValue')
  expect(request.timeoutMs).toBe(3000)
})
it.each([
  { config: true, requirements: false },
  { config: false, requirements: true }
])('refuses enforced Mac policy %o', async (value) => {
  run.mockResolvedValue({ code: 0, stdout: JSON.stringify(value) })
  await expect(assertNativeCodexPolicyScope('darwin')).rejects.toThrow('requires review')
})
it.each([
  { code: 1, stdout: '' },
  { code: 0, stdout: 'invalid' },
  { code: 0, stdout: '{"config":false,"requirements":false,"other":true}' },
  { code: 0, timedOut: true, stdout: '{}' }
])('fails closed on an unverifiable Mac query %o', async (value) => {
  run.mockResolvedValue(value)
  await expect(assertNativeCodexPolicyScope('darwin')).rejects.toThrow('could not be verified')
})
