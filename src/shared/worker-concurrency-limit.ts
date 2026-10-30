export function resolveWorkerConcurrencyLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Maximum concurrent workers must be a positive integer or null')
  }
  return value
}
