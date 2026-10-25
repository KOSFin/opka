import type { Page } from '@stablyai/playwright-test'

export async function waitForElectronRenderer(page: Page, packaged: boolean): Promise<void> {
  await page.waitForFunction(
    (packaged) => (packaged ? Boolean(window.api) : Boolean(window.__store)),
    packaged,
    { timeout: 30_000 }
  )
}

export async function readRestartRendererState<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    // Hydration can replace the document; only its enclosing state poll retries this transition.
    if (error instanceof Error && error.message.includes('Execution context was destroyed')) {
      return null
    }
    throw error
  }
}
