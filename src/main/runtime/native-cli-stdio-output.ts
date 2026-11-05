import type { NativeCliStdioEvent } from '../../shared/native-cli-stdio'

const OUTPUT_WINDOW_BYTES = 256 * 1024
const PAUSE_AT_BYTES = 128 * 1024
const MAX_CHUNK_BYTES = 64 * 1024
const FRAME_BYTES = 32 * 1024

/** Explicit consumer acknowledgements bound both the transport and unread native pipes. */
export class NativeCliStdioOutput {
  private readonly pending = new Map<number, { frame: NativeCliStdioEvent; bytes: number }>()
  private bytes = 0
  private next = 0
  private sent = 0
  private acknowledged = 0
  private emit: ((event: NativeCliStdioEvent) => void) | undefined
  private exitCode: number | undefined
  private closed = false

  constructor(
    private readonly pressure: (paused: boolean) => void,
    private readonly completed: () => void
  ) {}

  write(channel: 'stdout' | 'stderr', chunk: Buffer): void {
    if (this.closed || this.exitCode !== undefined) {
      throw new Error('Native CLI output arrived after transport closure.')
    }
    if (chunk.byteLength > MAX_CHUNK_BYTES || this.bytes + chunk.byteLength > OUTPUT_WINDOW_BYTES) {
      throw new Error('Native CLI output exceeded its bounded delivery window.')
    }
    for (let offset = 0; offset < chunk.length; offset += FRAME_BYTES) {
      const part = chunk.subarray(offset, offset + FRAME_BYTES)
      const sequence = ++this.next
      this.pending.set(sequence, {
        frame: { type: 'native-stdio-output', sequence, channel, bytes: part.toString('base64') },
        bytes: part.byteLength
      })
      this.bytes += part.byteLength
    }
    this.pressure(this.bytes >= PAUSE_AT_BYTES)
    this.flush()
  }

  attach(emit: (event: NativeCliStdioEvent) => void): () => void {
    if (this.emit || this.closed) {
      throw new Error('Native CLI stdio already has an output owner.')
    }
    this.emit = emit
    this.flush()
    return () => {
      this.emit = undefined
      this.closed = true
      this.pending.clear()
      this.bytes = 0
    }
  }

  acknowledge(sequence: number): void {
    if (sequence > this.sent) {
      throw new Error('Native CLI output acknowledgement is out of sequence.')
    }
    if (sequence <= this.acknowledged) {
      return
    }
    for (const [key, value] of this.pending) {
      if (key > sequence) {
        break
      }
      this.bytes -= value.bytes
      this.pending.delete(key)
    }
    this.acknowledged = sequence
    this.pressure(this.bytes >= PAUSE_AT_BYTES)
    this.flush()
  }

  finish(code: number): void {
    this.exitCode = code
    this.flush()
  }

  private flush(): void {
    if (!this.emit || this.closed) {
      return
    }
    try {
      for (const [sequence, value] of this.pending) {
        if (sequence > this.sent) {
          this.sent = sequence
          this.emit(value.frame)
        }
      }
      if (this.exitCode !== undefined && this.pending.size === 0) {
        this.closed = true
        this.emit({ type: 'native-stdio-exit', code: this.exitCode })
        this.completed()
      }
    } catch (error) {
      this.closed = true
      this.pending.clear()
      this.bytes = 0
      this.completed()
      throw error
    }
  }
}
