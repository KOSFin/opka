// Presentation only: every mount still checks the owning runtime.
export class TaskSnapshotCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number; savedAt: number }>()
  private readonly pending = new Map<string, Promise<T>>()
  private bytes = 0

  constructor(
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly maxEntries = 32,
    private readonly ttlMs = 10 * 60_000
  ) {}

  peek(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key)
    if (entry && now - entry.savedAt >= this.ttlMs) {
      this.entries.delete(key)
      this.bytes -= entry.bytes
      return undefined
    }
    return entry?.value
  }

  invalidate(key: string): void {
    const entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
      this.bytes -= entry.bytes
    }
    this.pending.delete(key)
  }

  load(key: string, read: () => Promise<T>): Promise<T> {
    const pending = this.pending.get(key)
    if (pending) {
      return pending
    }
    const result = read()
      .then((value) => {
        if (this.pending.get(key) === result) {
          const bytes = new TextEncoder().encode(JSON.stringify(value)).length
          this.bytes -= this.entries.get(key)?.bytes ?? 0
          this.entries.delete(key)
          if (bytes <= this.maxBytes) {
            this.entries.set(key, { value, bytes, savedAt: Date.now() })
            this.bytes += bytes
          }
          while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
            const oldest = this.entries.entries().next().value
            if (!oldest) {
              break
            }
            this.entries.delete(oldest[0])
            this.bytes -= oldest[1].bytes
          }
        }
        return value
      })
      .finally(() => {
        if (this.pending.get(key) === result) {
          this.pending.delete(key)
        }
      })
    this.pending.set(key, result)
    return result
  }
}
