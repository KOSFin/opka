import { createHash, randomUUID } from 'node:crypto'
import { open, rm, statfs, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { ensurePrivateEngineDirectory } from './engine-runtime-config'
import { CodexReplayJsonScanner, type CodexReplayMetadata } from './codex-replay-json-scanner'

const SMALL_RESERVE_BYTES = 64 * 1024 * 1024
const LARGE_THRESHOLD_BYTES = 16 * 1024 * 1024
const FREE_DISK_FLOOR_BYTES = 2 * 1024 * 1024 * 1024

export class CodexReplayAdmissionError extends Error {
  constructor(
    readonly status: 413 | 422 | 429 | 507,
    message: string
  ) {
    super(message)
  }
}

export class CodexReplaySpoolBudget {
  private active = 0
  private large = 0
  private reserved = 0

  constructor(
    readonly directory: string,
    private readonly capacityBytes: number,
    private readonly assertOwner: () => void
  ) {
    if (
      !Number.isSafeInteger(capacityBytes) ||
      (capacityBytes !== 0 && capacityBytes < 4 * SMALL_RESERVE_BYTES)
    ) {
      throw new Error(
        'Replay capacity must be zero for physical disk admission or a finite byte budget.'
      )
    }
  }

  acquire(kind: 'request' | 'response' = 'request'): CodexReplaySpool {
    this.assertOwner()
    if (process.platform === 'win32') {
      throw new CodexReplayAdmissionError(
        422,
        'Native replay spool requires verified owner-only Windows ACLs.'
      )
    }
    ensurePrivateEngineDirectory(this.directory)
    this.active++
    return new CodexReplaySpool(this, join(this.directory, `${randomUUID()}.json`), kind)
  }

  reserve(spool: CodexReplaySpool, delta: number): void {
    this.assertOwner()
    if (!Number.isSafeInteger(delta) || delta < 1) {
      throw new Error('Native replay reservation is invalid.')
    }
    const becomesLarge = !spool.isLarge && spool.bytes + delta > LARGE_THRESHOLD_BYTES
    const ceiling =
      spool.isLarge || becomesLarge ? this.capacityBytes - SMALL_RESERVE_BYTES : this.capacityBytes
    if (this.capacityBytes !== 0 && this.reserved + 2 * delta > ceiling) {
      throw new CodexReplayAdmissionError(
        413,
        'Aggregate native replay disk capacity is exhausted.'
      )
    }
    if (becomesLarge) {
      this.large++
      spool.isLarge = true
    }
    this.reserved += 2 * delta
    spool.bytes += delta
  }

  assertCurrentOwner(): void {
    this.assertOwner()
  }

  release(spool: CodexReplaySpool): void {
    this.assertOwner()
    this.active--
    this.reserved -= 2 * spool.bytes
    if (spool.isLarge) {
      this.large--
    }
  }

  async assertDiskFree(nextBytes: number): Promise<void> {
    const info = await statfs(this.directory)
    const free = info.bavail * info.bsize
    if (free < 2 * nextBytes + FREE_DISK_FLOOR_BYTES) {
      throw new CodexReplayAdmissionError(507, 'Native replay spool disk is full.')
    }
  }

  snapshot(): { active: number; large: number; reservedBytes: number } {
    return { active: this.active, large: this.large, reservedBytes: this.reserved }
  }
}

/** One private replayable request, retained until the owning route has terminal proof. */
export class CodexReplaySpool {
  bytes = 0
  isLarge = false
  private disposed = false
  private disposeRequested = false
  private disposePromise: Promise<void> | null = null
  private pathUnlinked = false
  private complete = false
  private metadata: CodexReplayMetadata | null = null
  private readonly digest = createHash('sha256')
  private file: FileHandle | undefined

  constructor(
    private readonly budget: CodexReplaySpoolBudget,
    readonly path: string,
    readonly kind: 'request' | 'response'
  ) {}

  ingest(input: AsyncIterable<Buffer | string>): Promise<CodexReplayMetadata>
  ingest(input: AsyncIterable<Buffer | string>, kind: 'response'): Promise<null>
  async ingest(
    input: AsyncIterable<Buffer | string>,
    kind: 'request' | 'response' = 'request'
  ): Promise<CodexReplayMetadata | null> {
    if (this.complete || this.disposeRequested) {
      throw new Error('Native replay spool was already used.')
    }
    const scanner = new CodexReplayJsonScanner()
    const file = await open(this.path, 'wx+', 0o600)
    this.file = file
    try {
      await rm(this.path)
      this.pathUnlinked = true
      for await (const item of input) {
        const buffer = Buffer.isBuffer(item) ? item : Buffer.from(item)
        for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
          const chunk = buffer.subarray(offset, Math.min(offset + 64 * 1024, buffer.length))
          this.budget.reserve(this, chunk.length)
          await this.budget.assertDiskFree(chunk.length)
          scanner.write(chunk)
          await file.writeFile(chunk)
          this.digest.update(chunk)
        }
      }
      if (kind === 'request') {
        this.metadata = scanner.finish()
      } else {
        scanner.finishValidJson()
      }
      this.complete = true
      return this.metadata
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  async *rewritten(prefix: string): AsyncGenerator<Buffer> {
    if (!this.complete || this.disposeRequested || !this.metadata) {
      throw new Error('Native replay spool is incomplete.')
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(prefix)) {
      throw new Error('Native route prefix is invalid.')
    }
    const { model, modelStart, modelEnd } = this.metadata
    if (modelStart > 0) {
      yield* this.readRange(0, modelStart)
    }
    yield Buffer.from(JSON.stringify(`${prefix}/${model}`))
    if (modelEnd < this.bytes) {
      yield* this.readRange(modelEnd, this.bytes)
    }
  }

  private async *readRange(start: number, end: number): AsyncGenerator<Buffer> {
    const file = this.file
    if (!file || this.disposeRequested) {
      throw new Error('Native replay source is closed.')
    }
    for (let position = start; position < end;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - position))
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position)
      if (bytesRead < 1) {
        throw new Error('Native replay source ended early.')
      }
      position += bytesRead
      yield chunk.subarray(0, bytesRead)
    }
  }

  async *raw(): AsyncGenerator<Buffer> {
    if (!this.complete || this.disposeRequested) {
      throw new Error('Native replay spool is incomplete.')
    }
    yield* this.readRange(0, this.bytes)
  }

  forwardedBytes(prefix: string): number {
    if (!this.metadata) {
      throw new Error('Native replay spool is incomplete.')
    }
    return (
      this.bytes -
      (this.metadata.modelEnd - this.metadata.modelStart) +
      Buffer.byteLength(JSON.stringify(`${prefix}/${this.metadata.model}`))
    )
  }

  forwardedModelSpan(prefix: string): {
    start: number
    end: number
    model: string
    stream: boolean
  } {
    if (!this.metadata) {
      throw new Error('Native replay spool is incomplete.')
    }
    return {
      start: this.metadata.modelStart,
      end:
        this.metadata.modelStart +
        Buffer.byteLength(JSON.stringify(`${prefix}/${this.metadata.model}`)),
      model: `${prefix}/${this.metadata.model}`,
      stream: this.metadata.stream
    }
  }

  async forwardedSha256(prefix: string): Promise<string> {
    const digest = createHash('sha256')
    for await (const chunk of this.rewritten(prefix)) {
      digest.update(chunk)
    }
    return digest.digest('hex')
  }

  sha256(): string {
    if (!this.complete) {
      throw new Error('Native replay spool is incomplete.')
    }
    return this.digest.copy().digest('hex')
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise
    }
    if (this.disposed) {
      return Promise.resolve()
    }
    this.disposeRequested = true
    const pending = this.disposeResources()
    this.disposePromise = pending
    void pending.then(
      () => {
        this.disposePromise = null
      },
      () => {
        this.disposePromise = null
      }
    )
    return pending
  }

  private async disposeResources(): Promise<void> {
    if (this.file) {
      await this.file.close()
      this.file = undefined
    }
    this.budget.assertCurrentOwner()
    if (!this.pathUnlinked) {
      await rm(this.path, { force: true })
      this.pathUnlinked = true
    }
    this.budget.release(this)
    this.disposed = true
  }
}
