import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, type Page } from '@stablyai/playwright-test'

export async function runIsolatedFixtureGit(
  cwd: string,
  home: string,
  args: string[]
): Promise<string> {
  const result = await runProcess({
    program: 'git',
    args,
    cwd,
    env: {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      NODE_ENV: 'test',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0'
    },
    timeoutMs: 10_000
  })
  expect(result.code, `git ${args[0]}: ${result.stderr}`).toBe(0)
  return result.stdout.trim()
}

export async function captureHiddenGitScreenshot(
  page: Page,
  evidenceDir: string,
  name: string
): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true })
  const session = await page.context().newCDPSession(page)
  try {
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: false,
      captureBeyondViewport: false
    })
    writeFileSync(path.join(evidenceDir, name), Buffer.from(data, 'base64'))
  } finally {
    await session.detach()
  }
}
