import { writeFile } from 'node:fs/promises'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.skip(!process.env.ORCA_FORK_AUDIT_ELECTRON, 'Explicit isolated background Electron required')
test.use({
  orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1', ORCA_TELEMETRY_DISABLED: '1' },
  trace: 'off',
  screenshot: 'off'
})

test('command automation UI creates, edits and reads synthetic history without execution', async ({
  electronApp,
  orcaPage: page
}, testInfo) => {
  await waitForSessionReady(page)
  const reportTarget = {
    runtimeId: 'synthetic-host',
    hostId: 'local',
    workspaceId: 'synthetic-workspace',
    chatSessionId: 'synthetic-chat',
    registrationGeneration: 1
  }
  await electronApp.evaluate(
    ({ ipcMain }, { reportTarget }) => {
      let definition: Record<string, unknown> | null = null
      const calls: { method: string; params: unknown }[] = []
      Reflect.set(globalThis, '__syntheticCommandCalls', calls)
      const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers')
      if (!(handlers instanceof Map)) {
        throw new Error('Runtime IPC registry unavailable')
      }
      const originalCall: unknown = handlers.get('runtime:call')
      if (typeof originalCall !== 'function') {
        throw new Error('Runtime IPC handler unavailable')
      }
      ipcMain.removeHandler('runtime:call')
      ipcMain.handle(
        'runtime:call',
        async (event, request: { method: string; params?: unknown }) => {
          if (request.method === 'automation.runNowV2' || request.method === 'automation.runNow') {
            calls.push({ method: request.method, params: request.params })
            throw new Error(`Synthetic UI fixture must not execute ${request.method}`)
          }
          if (
            ![
              'status.get',
              'automation.list',
              'automation.createV2',
              'automation.updateV2',
              'automation.runs'
            ].includes(request.method)
          ) {
            return originalCall(event, request)
          }
          calls.push({ method: request.method, params: request.params })
          const success = (result: unknown) => ({ id: 'synthetic-command', ok: true, result })
          if (request.method === 'status.get') {
            return success({
              capabilities: ['automation.command-pipeline.v1', 'automation.list-host-scope.v1']
            })
          }
          if (request.method === 'automation.list') {
            return success({
              automations: [],
              items: [],
              commandAutomations: definition ? [definition] : [],
              commandReportTargets: [
                {
                  setupId: 'synthetic-setup',
                  label: 'Synthetic primary chat',
                  target: reportTarget
                }
              ]
            })
          }
          if (request.method === 'automation.createV2') {
            const params = request.params
            const input =
              params && typeof params === 'object' ? Reflect.get(params, 'definition') : null
            if (!input || typeof input !== 'object') {
              throw new Error('Missing synthetic definition')
            }
            definition = {
              ...input,
              id: 'synthetic-command-1',
              revision: 1,
              nextRunAt: 1,
              createdAt: 1,
              updatedAt: 1
            }
            return success({ automation: definition })
          }
          if (request.method === 'automation.updateV2') {
            const params = request.params
            const updates =
              params && typeof params === 'object' ? Reflect.get(params, 'updates') : null
            if (!definition || !updates || typeof updates !== 'object') {
              throw new Error('Missing synthetic update')
            }
            definition = { ...definition, ...updates, revision: 2, updatedAt: 2 }
            return success({ automation: definition })
          }
          if (request.method === 'automation.runs') {
            const run = {
              id: 'synthetic-run-1',
              automationId: 'synthetic-command-1',
              title: 'Synthetic command report',
              scheduledFor: 1,
              createdAt: 1,
              status: 'completed',
              trigger: 'manual',
              sessionKind: 'command',
              workspaceId: null,
              chatSessionId: null,
              terminalSessionId: null,
              terminalPaneKey: null,
              terminalPtyId: null,
              precheckResult: null,
              usage: null,
              error: null,
              startedAt: 1,
              dispatchedAt: null,
              outputSnapshot: {
                format: 'plain_text',
                content: 'SYNTHETIC_REPORT_ONLY',
                capturedAt: 1,
                truncated: false
              },
              commandExecution: {
                version: 1,
                phase: 'settled',
                attempt: 1,
                observation: 'exited',
                finalReason: 'completed',
                deliveryStatus: 'history_only'
              }
            }
            return success({ runs: definition ? [run] : [], nextCursor: null })
          }
          return originalCall(event, request)
        }
      )
    },
    { reportTarget }
  )
  await page.evaluate(() => {
    const store = window.__store!
    const repo = store.getState().repos[0]
    if (!repo) {
      throw new Error('Seeded synthetic repo is unavailable')
    }
    store.setState({
      projectHostSetups: [
        {
          id: 'synthetic-setup',
          projectId: repo.id,
          hostId: 'local',
          repoId: repo.id,
          path: repo.path,
          displayName: 'Synthetic project folder',
          setupState: 'ready',
          setupMethod: 'imported-existing-folder',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    store.getState().openAutomationsPage()
  })
  await page.getByRole('button', { name: 'Command mode (local)' }).click()
  await page.getByRole('button', { name: 'New command automation' }).click()
  const editor = page.getByRole('dialog', { name: 'New command automation' })
  await editor.getByRole('textbox', { name: 'Name' }).fill('Synthetic command')
  await editor.getByRole('combobox', { name: 'Project folder on this host' }).click()
  await page.getByRole('option', { name: 'Synthetic project folder' }).click()
  await editor.getByRole('textbox', { name: 'Script' }).fill('printf synthetic')
  await editor.getByRole('combobox', { name: 'Primary chat report' }).click()
  await page.getByRole('option', { name: 'Synthetic primary chat' }).click()
  await editor.getByRole('button', { name: 'Validate draft' }).click()
  await expect(editor.getByText('Draft is valid. No command ran.')).toBeVisible()
  await editor.getByRole('button', { name: 'Save draft' }).click()
  await expect(editor).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Synthetic command' })).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = page.getByRole('dialog', { name: 'Edit command automation' })
  await expect(edit.getByRole('combobox', { name: 'Primary chat report' })).toContainText(
    'Synthetic primary chat'
  )
  await edit.getByRole('textbox', { name: 'Name' }).fill('Synthetic command edited')
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic command edited' })).toBeVisible()
  await expect(page.getByText('SYNTHETIC_REPORT_ONLY').first()).toBeVisible()
  await page.getByRole('button', { name: 'Retained reports' }).click()
  await expect(page.getByRole('region', { name: 'Retained command reports' })).toContainText(
    'SYNTHETIC_REPORT_ONLY'
  )
  const calls = await electronApp.evaluate(() => Reflect.get(globalThis, '__syntheticCommandCalls'))
  expect(calls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        method: 'automation.createV2',
        params: expect.objectContaining({
          definition: expect.objectContaining({
            projectId: expect.any(String),
            execution: expect.objectContaining({ reportTarget })
          })
        })
      }),
      expect.objectContaining({
        method: 'automation.updateV2',
        params: expect.objectContaining({ expectedRevision: 1 })
      })
    ])
  )
  expect(
    calls.some(
      (call: { method: string }) =>
        call.method === 'automation.runNowV2' || call.method === 'automation.runNow'
    )
  ).toBe(false)
  const cdp = await page.context().newCDPSession(page)
  try {
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: false,
      captureBeyondViewport: false
    })
    await writeFile(
      testInfo.outputPath('command-automation-hidden.png'),
      Buffer.from(screenshot.data, 'base64')
    )
  } finally {
    await cdp.detach()
  }
})
