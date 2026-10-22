import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { verifyRequiredPrContext } from '../../.github/scripts/check-required-pr-context.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

describe('fork CI safety and required checks', () => {
  it('owns the existing required context without shadow workflows', () => {
    expect(() => verifyRequiredPrContext(parse)).not.toThrow()
  })

  it('requires tests, all desktop platforms and hidden GUI checks', () => {
    expect(workflow.jobs.verify.needs).toEqual(['static', 'regression', 'desktop', 'electron'])
    expect(workflow.jobs.desktop.strategy.matrix.os).toEqual([
      'ubuntu-24.04',
      'macos-15',
      'windows-2022'
    ])
    expect(workflow.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const text = readFileSync('.github/workflows/pr.yml', 'utf8')
    expect(text).not.toMatch(
      /secrets\.|pull_request_target|self-hosted|blacksmith|continue-on-error|gh release|electron-builder/
    )
    expect(text).toContain('job.result !== "success"')
    expect(text).toContain('if-no-files-found: error')
  })
})
