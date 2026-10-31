import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'
import {
  projectWorkAccountSnapshot,
  projectWorkRenderReplies
} from './mobile-web-app-project-work-fixtures.mjs'

const enabled = mobileWebAppDependenciesPresent()
const render = enabled ? describe : describe.skip
const sizes = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 }
]
const host = {
  id: 'render-check-host',
  name: 'Opka test server',
  endpoint: 'ws://render-check',
  lastConnected: 1
}
let scratch, server, browser, origin, version, faultGrant, evidence
beforeAll(async () => {
  if (!enabled) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'opka-project-work-render-'))
  evidence = process.env.OPKA_MOBILE_EVIDENCE_DIR || join(scratch, 'screenshots')
  await mkdir(evidence, { recursive: true })
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const served = await createBundleServer({ outDir: built.outDir, cspHeader: await readShellCsp() })
  server = served.server
  origin = served.origin
  version = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 240_000)
afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openScreen(size, section) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } })
  const faults = []
  page.on('pageerror', (error) => faults.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      faults.push(message.text())
    }
  })
  await page.addInitScript(installShellDouble, {
    version,
    sessionId: 'project-work-render',
    buildId: 'synthetic-render',
    route: { pathname: `/h/${host.id}/${section}` },
    host,
    storage: {},
    faultGrant,
    grants: [
      faultGrant,
      'navigate',
      'storage',
      'externalLink',
      'haptics',
      'native.clipboard.write'
    ],
    pageRoutes: ['/h/[hostId]', '/h/[hostId]/tasks', '/h/[hostId]/accounts'],
    replies: projectWorkRenderReplies,
    streams: ['accounts.subscribe']
  })
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.documentElement.dataset.orcaWebEntry === 'mounted', {
    timeout: 60_000
  })
  await page.waitForTimeout(1000)
  await page.screenshot({ path: join(evidence, `${size.name}-${section}-initial.png`) })
  await writeFile(
    join(evidence, `${size.name}-${section}-initial.json`),
    JSON.stringify(
      {
        faults,
        ...(await page.evaluate(() => ({
          body: document.body.innerText,
          url: location.href,
          requests: globalThis.__orcaRenderCheckRequests,
          subscriptions: globalThis.__orcaRenderCheckSubscribes,
          reports: globalThis.__orcaRenderCheckFaults,
          notifies: globalThis.__orcaRenderCheckNotifies
        })))
      },
      null,
      2
    )
  )
  if (section === 'accounts') {
    await page.waitForFunction(() =>
      (globalThis.__orcaRenderCheckSubscribes ?? []).some(
        (item) => item.method === 'accounts.subscribe'
      )
    )
    await page.evaluate((snapshot) => {
      const subscription = globalThis.__orcaRenderCheckSubscribes.find(
        (item) => item.method === 'accounts.subscribe'
      )
      globalThis.__orcaRenderCheckEmitEvent(subscription.id, { type: 'ready', snapshot })
    }, projectWorkAccountSnapshot)
  }
  return { page, faults }
}
async function capture(page, size, name) {
  await page.screenshot({ path: join(evidence, `${size.name}-${name}.png`) })
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1)
}
async function clean(opened) {
  const reported = await opened.page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])
  expect([...opened.faults, ...reported]).toEqual([])
}
render.each(sizes)('project work on $name', (size) => {
  it('opens grouped tasks, report and activity sections with reversible navigation', async () => {
    const opened = await openScreen(size, 'tasks')
    const { page } = opened
    try {
      await page.getByText('Website integration', { exact: true }).waitFor()
      await capture(page, size, 'projects')
      await page.getByText('Website integration', { exact: true }).click()
      await page.getByText('Connect the website to the control panel', { exact: true }).waitFor()
      expect(await page.getByText('Planned · 1', { exact: true }).isVisible()).toBe(true)
      expect(await page.getByText('In progress · 1', { exact: true }).isVisible()).toBe(true)
      await capture(page, size, 'board')
      await page.getByText('Connect the website to the control panel', { exact: true }).click()
      await page.getByText('Use the approved API contract.', { exact: false }).waitFor()
      await capture(page, size, 'overview')
      await page.getByRole('radio', { name: 'Reports (1)', exact: true }).click()
      await page.getByText('result.md', { exact: true }).click()
      await page.getByText('The synthetic contract checks passed.', { exact: true }).waitFor()
      await capture(page, size, 'report')
      await page.getByRole('button', { name: 'Back', exact: true }).click()
      await page.getByRole('radio', { name: 'Activity', exact: true }).click()
      await page.getByText('Task created for review', { exact: true }).waitFor()
      await capture(page, size, 'activity')
      await clean(opened)
    } finally {
      await page.close()
    }
  }, 90_000)
  it('separates account and pool controls and completes device prompt interactions', async () => {
    const opened = await openScreen(size, 'accounts')
    const { page } = opened
    try {
      await page.getByText('Add Codex account', { exact: true }).waitFor()
      await capture(page, size, 'accounts')
      await page.getByRole('radio', { name: 'Pools & switching', exact: true }).click()
      await page.waitForTimeout(300)
      await capture(page, size, 'pools-initial')
      await writeFile(
        join(evidence, `${size.name}-pools-initial.json`),
        JSON.stringify(
          await page.evaluate(() => ({
            body: document.body.innerText,
            requests: globalThis.__orcaRenderCheckRequests
          })),
          null,
          2
        )
      )
      await page.getByText('test@example.invalid · Selected login', { exact: true }).waitFor()
      await capture(page, size, 'pools')
      await page.getByRole('radio', { name: 'Accounts', exact: true }).click()
      await page.getByText('Add Codex account', { exact: true }).click()
      await page.getByText('TEST-ABCDE', { exact: true }).waitFor()
      await capture(page, size, 'device-sign-in')
      await page.getByText('Copy code', { exact: true }).click()
      await page.getByText('Code copied', { exact: true }).waitFor()
      await page.getByText('Open sign-in page', { exact: true }).click()
      const notifies = await page.evaluate(() => globalThis.__orcaRenderCheckNotifies ?? [])
      expect(JSON.stringify(notifies)).toContain('https://auth.openai.com/codex/device')
      const requests = await page.evaluate(() => globalThis.__orcaRenderCheckRequests ?? [])
      expect(requests).toContainEqual({
        method: 'native.clipboard.write',
        params: { mime: 'text', value: 'TEST-ABCDE' }
      })
      await page.getByText('Cancel sign-in', { exact: true }).click()
      await page.getByText('Add Codex account', { exact: true }).waitFor()
      expect(await page.getByText('TEST-ABCDE', { exact: true }).count()).toBe(0)
      await page.getByText('Add Claude account in terminal', { exact: true }).click()
      await page.getByText('Open Claude sign-in in…', { exact: true }).waitFor()
      await capture(page, size, 'claude-workspace-picker')
      await page.getByText('Sign-in workspace', { exact: true }).click()
      await page.waitForFunction(() =>
        (globalThis.__orcaRenderCheckRequests ?? []).some(
          (request) => request.method === 'accounts.openSignInTerminal'
        )
      )
      const signInCalls = await page.evaluate(() => globalThis.__orcaRenderCheckRequests ?? [])
      expect(signInCalls).toContainEqual({
        method: 'accounts.openSignInTerminal',
        params: {
          provider: 'claude',
          worktree: 'folder:render-sign-in',
          clientMutationId: expect.any(String)
        }
      })
      await clean(opened)
    } finally {
      await page.close()
    }
  }, 90_000)
})
