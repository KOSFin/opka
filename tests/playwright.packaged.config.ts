import { defineConfig } from '@stablyai/playwright-test'
import configuration from './playwright.config'

export default defineConfig({
  ...configuration,
  globalSetup: undefined,
  globalTeardown: undefined,
  workers: 1,
  projects: [
    {
      name: 'electron-headless',
      testMatch: '**/fork-packaged-installer.spec.ts',
      metadata: { orcaHeadful: false }
    }
  ]
})
