import type { CodexRoutingHttpOptions } from './codex-routing-http-types'

export function assertCodexRoutingHttpBudget(options: CodexRoutingHttpOptions): void {
  const { maxConcurrent, maxRequestBytes, maxResponseBytes, responseHeaderTimeoutMs } = options
  if (
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > 16 ||
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes < 1 ||
    maxRequestBytes > 32 * 1024 * 1024 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 64 * 1024 * 1024 ||
    maxConcurrent * maxRequestBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(responseHeaderTimeoutMs) ||
    responseHeaderTimeoutMs < 1 ||
    responseHeaderTimeoutMs > 300_000
  ) {
    throw new Error('Codex routing HTTP resource budget is invalid')
  }
}
