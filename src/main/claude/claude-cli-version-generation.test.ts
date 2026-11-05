import { beforeEach, expect, it, vi } from 'vitest'
const hooks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: hooks.run }))
beforeEach(() => {
  vi.resetModules()
  hooks.run.mockReset()
  hooks.run.mockResolvedValue({ code: 0, stdout: '2.1.318 (Claude Code)', stderr: '' })
})
it('coalesces same-file probes but invalidates a replaced native executable immediately', async () => {
  const { probeRecentClaudeCliVersion } = await import('./claude-hook-event-versions')
  expect(
    await Promise.all([
      probeRecentClaudeCliVersion('/synthetic/claude', 'generation-1'),
      probeRecentClaudeCliVersion('/synthetic/claude', 'generation-1')
    ])
  ).toEqual(['2.1.318', '2.1.318'])
  expect(hooks.run).toHaveBeenCalledOnce()
  hooks.run.mockResolvedValueOnce({ code: 0, stdout: '2.1.319 (Claude Code)', stderr: '' })
  expect(await probeRecentClaudeCliVersion('/synthetic/claude', 'generation-2')).toBe('2.1.319')
  expect(hooks.run).toHaveBeenCalledTimes(2)
})
it('bounds remembered executable generations while preserving legacy caller cache behavior', async () => {
  const { probeRecentClaudeCliVersion } = await import('./claude-hook-event-versions')
  await probeRecentClaudeCliVersion('/synthetic/legacy')
  await probeRecentClaudeCliVersion('/synthetic/legacy')
  expect(hooks.run).toHaveBeenCalledOnce()
  for (let index = 0; index < 129; index++) {
    await probeRecentClaudeCliVersion('/synthetic/claude', `generation-${index}`)
  }
  await probeRecentClaudeCliVersion('/synthetic/claude', 'generation-0')
  expect(hooks.run).toHaveBeenCalledTimes(131)
})
