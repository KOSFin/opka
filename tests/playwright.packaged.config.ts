import { defineConfig } from '@stablyai/playwright-test'
import configuration from './playwright.config'

export default defineConfig({
  ...configuration,
  testMatch: '**/fork-packaged-installer.spec.ts',
  globalSetup: undefined,
  globalTeardown: undefined,
  workers: 1
})
