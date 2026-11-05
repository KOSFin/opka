import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { NativeCliStdioControl } from '../../shared/native-cli-stdio'
import type { ManagedProviderProcess } from '../provider-process/managed-provider-process'
import type { ProviderGroupIdentity } from '../provider-process/provider-group-orphan-guard'
import { readPosixProcessRow } from '../provider-process/provider-process-row-read'
import { NativeCliStdioOutput } from './native-cli-stdio-output'

type Input = z.infer<typeof NativeCliStdioControl>

/** One raw invocation; unread output is paused, never copied to a transcript or disk cache. */
export class NativeCliStdioSession {
  managed?: ManagedProviderProcess
  group?: ProviderGroupIdentity
  exited = false
  attached = false
  outputFailed = false
  controlFailed = false
  private inputSequence = 0
  private inputDigest = ''
  private inputPending: Promise<void> | undefined
  private closing: Promise<boolean> | undefined
  private signalling: Promise<void> | undefined
  private inputFailed = false
  private resolveDone!: () => void
  readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve
  })
  readonly output = new NativeCliStdioOutput(
    (paused) => {
      const child = this.managed?.child
      for (const pipe of [child?.stdout, child?.stderr]) {
        if (paused) {
          pipe?.pause()
        } else {
          pipe?.resume()
        }
      }
    },
    () => this.resolveDone()
  )

  constructor(
    readonly generation: string,
    private readonly retire: () => void,
    private readonly release: (proven: boolean) => Promise<void>
  ) {}

  noteInputFailure(): void {
    this.inputFailed = true
  }

  noteControlFailure(): void {
    if (this.controlFailed || this.exited) {
      return
    }
    this.controlFailed = true
    this.receive(
      'stderr',
      Buffer.from(
        'Opka could not verify native account control; this command did not complete successfully.\n'
      )
    )
  }

  noteOutputFailure(): void {
    this.outputFailed = true
    this.managed?.child.stdout.pause()
    this.managed?.child.stderr.pause()
    void this.close().catch(() => {})
  }

  receive(channel: 'stdout' | 'stderr', chunk: Buffer): void {
    try {
      this.output.write(channel, chunk)
    } catch {
      this.noteOutputFailure()
    }
  }

  async control(params: Input): Promise<void> {
    if (params.generation !== this.generation) {
      throw new Error('Native CLI input owner changed.')
    }
    this.output.acknowledge(params.sequence)
    if (params.signal) {
      if (
        params.input !== undefined ||
        params.eof ||
        params.inputSequence !== undefined ||
        this.exited ||
        this.closing
      ) {
        throw new Error('Native CLI signal is not valid for this generation.')
      }
      if (this.signalling) {
        return this.signalling
      }
      const signal = this.write(params)
      this.signalling = signal
      try {
        await signal
      } finally {
        if (this.signalling === signal) {
          this.signalling = undefined
        }
      }
      return
    }
    const commands = [params.input !== undefined, params.eof === true, !!params.signal].filter(
      Boolean
    )
    if (this.exited && params.eof === true && commands.length === 1) {
      return
    }
    if (!commands.length) {
      if (params.inputSequence !== undefined) {
        throw new Error('Native CLI input has no command.')
      }
      return
    }
    if (commands.length !== 1 || !params.inputSequence) {
      throw new Error('Invalid native CLI input.')
    }
    const digest = createHash('sha256')
      .update(JSON.stringify([params.input, params.eof, params.signal]))
      .digest('hex')
    if (params.inputSequence === this.inputSequence) {
      if (digest !== this.inputDigest) {
        throw new Error('Native CLI input generation conflicted.')
      }
      return this.inputPending
    }
    if (
      this.exited ||
      this.closing ||
      this.inputPending ||
      params.inputSequence !== this.inputSequence + 1
    ) {
      throw new Error('Native CLI input is not ready for this generation.')
    }
    this.inputSequence = params.inputSequence
    this.inputDigest = digest
    const operation = this.write(params)
    this.inputPending = operation
    try {
      await operation
    } finally {
      if (this.inputPending === operation) {
        this.inputPending = undefined
      }
    }
  }

  private async write(params: Input): Promise<void> {
    const child = this.managed?.child
    if (!child) {
      throw new Error('Native CLI process is unavailable.')
    }
    if (!params.signal && this.inputFailed) {
      throw new Error('Native CLI input pipe is closed.')
    }
    if (params.signal) {
      const group = this.group
      const row = group && (await readPosixProcessRow(group.pgid))
      if (
        !group ||
        !row ||
        row === 'unverifiable' ||
        row.startedAt !== group.startedAt ||
        row.ppid !== child.pid
      ) {
        throw new Error('Native CLI process identity is unverifiable.')
      }
      process.kill(-group.pgid, params.signal)
    } else if (params.eof) {
      child.stdin.end()
    } else {
      const bytes = Buffer.from(params.input ?? '', 'base64')
      if (bytes.byteLength > 32 * 1024 || bytes.toString('base64') !== params.input) {
        throw new Error('Native CLI input encoding is invalid.')
      }
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()))
      )
    }
  }

  close(): Promise<boolean> {
    if (this.closing) {
      return this.closing
    }
    this.retire()
    const closing = (async () => {
      const managed = this.managed
      if (!managed) {
        return false
      }
      const verdict = await managed.close()
      let proven = managed.providerNotStarted === true
      if (!proven && verdict.root === 'exited' && this.group) {
        try {
          process.kill(-this.group.pgid, 0)
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
            proven = true
          }
        }
      }
      await this.release(proven)
      return proven
    })()
    this.closing = closing
    void closing.then(
      (proven) => {
        if (!proven && this.closing === closing) {
          this.closing = undefined
        }
      },
      () => {
        if (this.closing === closing) {
          this.closing = undefined
        }
      }
    )
    return closing
  }
}
