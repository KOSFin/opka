import { _electron as electron, expect } from '@stablyai/playwright-test'
import { build as buildMain } from 'esbuild'
import { build as buildRenderer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Requires background launch')
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const parent = path.join(root, '.bench-fixtures')
mkdirSync(parent, { recursive: true })
const output = mkdtempSync(path.join(parent, 'native-pool-setup-'))
const fixture = path.join(root, 'tests/tools/native-pool-setup-rendered')
const main = path.join(output, 'main.cjs')
const mobileRequire = createRequire(path.join(root, 'mobile/package.json'))
await buildMain({
  entryPoints: [path.join(root, 'tests/tools/benchmarks/spinner-rendering/main.ts')],
  outfile: main,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron']
})
for (const mobile of [false, true]) {
  await buildRenderer({
    configFile: false,
    root: fixture,
    base: './',
    logLevel: 'warn',
    plugins: mobile ? [react()] : [react(), tailwindcss()],
    define: { __DEV__: 'false', 'process.env.EXPO_OS': JSON.stringify('web') },
    resolve: {
      extensions: [
        '.web.tsx',
        '.web.ts',
        '.web.jsx',
        '.web.js',
        '.mjs',
        '.js',
        '.ts',
        '.tsx',
        '.json'
      ],
      alias: [
        { find: '@/runtime/runtime-rpc-client', replacement: path.join(fixture, 'fake-host.ts') },
        { find: '@/i18n/i18n', replacement: path.join(fixture, 'fake-host.ts') },
        ...(mobile
          ? [
              { find: /^.*\/BottomDrawer$/, replacement: path.join(fixture, 'platform.tsx') },
              {
                find: /^.*\/navigation\/route-handoff$/,
                replacement: path.join(fixture, 'platform.tsx')
              },
              {
                find: /^.*\/platform\/clipboard$/,
                replacement: path.join(fixture, 'platform.tsx')
              },
              {
                find: /^.*\/platform\/external-link$/,
                replacement: path.join(fixture, 'platform.tsx')
              },
              { find: /^lucide-react-native$/, replacement: path.join(fixture, 'icons.mjs') },
              {
                find: /^lucide-react-native\//,
                replacement: path.join(root, 'mobile/node_modules/lucide-react-native/')
              },
              { find: /^react-native$/, replacement: mobileRequire.resolve('react-native-web') },
              {
                find: 'react-dom',
                replacement: path.dirname(mobileRequire.resolve('react-dom/package.json'))
              },
              {
                find: 'react',
                replacement: path.dirname(mobileRequire.resolve('react/package.json'))
              }
            ]
          : []),
        { find: '@', replacement: path.join(root, 'src/renderer/src') }
      ]
    },
    build: {
      outDir: path.join(output, mobile ? 'mobile' : 'desktop'),
      emptyOutDir: true,
      rollupOptions: { input: path.join(fixture, mobile ? 'mobile.html' : 'index.html') }
    }
  })
}
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
const app = await electron.launch({
  args: [main, '--no-sandbox'],
  env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' }
})
const report = {
  scope:
    'Production desktop pool/Setup and mobile RN-web pool/Setup in hidden Electron, fake RPC host only; no native auth, shell installation or Android APK.',
  cases: []
}
try {
  const page = await app.firstWindow()
  await page.route('**/*', (route) =>
    /^(file|data|about):/.test(route.request().url()) ? route.continue() : route.abort()
  )
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const mobile of [false, true]) {
    const platform = mobile ? 'mobile' : 'desktop'
    await page.setViewportSize(mobile ? { width: 430, height: 932 } : { width: 1100, height: 900 })
    for (const mode of ['not-installed', 'modified', 'error']) {
      const url = pathToFileURL(path.join(output, platform, mobile ? 'mobile.html' : 'index.html'))
      url.searchParams.set('mode', mode)
      await page.goto(url.href)
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page
        .getByRole('button', { name: mobile ? 'Codex pool settings' : /Codex/ })
        .first()
        .click()
      const setup = page.getByRole('button', { name: 'Set up ordinary CLI', exact: true })
      const requests = async () => JSON.parse(await page.getByTestId('requests').textContent())
      if (mode === 'modified') {
        await expect(page.getByText(/needs review/).first()).toBeVisible()
        await expect(setup).toHaveCount(0)
      } else {
        await expect(setup).toBeVisible()
        expect(
          (await requests()).filter((row) => row.method.includes('installNative'))
        ).toHaveLength(0)
        await setup.click()
        await expect(page.getByRole('button', { name: 'Setting up…' })).toBeDisabled()
        await expect(
          page
            .getByText(
              mode === 'error'
                ? /could not be confirmed/
                : /Ordinary CLI commands are ready|CLI setup is ready/
            )
            .first()
        ).toBeVisible()
        const calls = await requests()
        expect(
          calls.filter((row) => row.method === 'accounts.installNativeCliIntegration')
        ).toEqual([{ host: 'fixture-host-a', method: 'accounts.installNativeCliIntegration' }])
        expect(calls.filter((row) => row.method === 'accounts.codexRoutingState')).toHaveLength(2)
      }
      if (mode === 'not-installed') {
        await page
          .getByRole('switch', {
            name: mobile ? 'codex apply pool to new work' : 'Use automatic pool'
          })
          .click()
        await page
          .getByRole('button', {
            name: mobile ? 'Save codex pool' : 'Save codex pool',
            exact: true
          })
          .click()
        await expect
          .poll(
            async () =>
              (await requests()).filter((row) => row.method === 'accountPool.update').length
          )
          .toBe(1)
      }
      await expect(page.locator('body')).not.toHaveText(/Synthetic private host error/)
      const cdp = await page.context().newCDPSession(page)
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path.join(output, `${platform}-${mode}.png`), Buffer.from(data, 'base64'))
      await cdp.detach()
      report.cases.push({
        platform,
        mode,
        calls: await requests(),
        horizontalOverflow: await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        )
      })
      expect(report.cases.at(-1).horizontalOverflow).toBe(false)
    }
  }
  expect(errors).toEqual([])
  report.windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  )
  expect(report.windows.every((window) => !window.visible && !window.focused)).toBe(true)
} finally {
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`Native pool Setup render evidence: ${output}`)
  await app.close()
}
