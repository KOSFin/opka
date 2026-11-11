import {
  CodexReplayJsonString,
  isCodexReplayNumberByte,
  selectCodexReplayRoutingValue,
  type CodexReplayMetadata,
  type CodexReplayRoutingKey
} from './codex-replay-json-value'

export type { CodexReplayMetadata } from './codex-replay-json-value'

type ObjectFrame = {
  kind: 'object'
  phase: 'key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end'
  key: string | null
}
type ArrayFrame = { kind: 'array'; phase: 'value-or-end' | 'value' | 'comma-or-end' }
type Frame = ObjectFrame | ArrayFrame
const MAX_DEPTH = 64
const MAX_NUMBER_BYTES = 128

const isSpace = (byte: number): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
/** Validates the complete JSON while retaining only bounded routing metadata. */
export class CodexReplayJsonScanner {
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true })
  private readonly string = new CodexReplayJsonString()
  private readonly frames: Frame[] = []
  private readonly seen = new Set<CodexReplayRoutingKey>()
  private mode: 'normal' | 'string' | 'number' | 'literal' = 'normal'
  private root: 'value' | 'done' = 'value'
  private position = 0
  private capture: number[] = []
  private captureLimit = 0
  private selected: CodexReplayRoutingKey | null = null
  private literal = ''
  private readonly metadata: Partial<CodexReplayMetadata> = { stream: false }

  write(chunk: Buffer): void {
    for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
      const slice = chunk.subarray(offset, Math.min(offset + 64 * 1024, chunk.length))
      this.utf8.decode(slice, { stream: true })
      for (const byte of slice) {
        this.consume(byte)
        this.position++
      }
    }
  }

  finish(): CodexReplayMetadata {
    this.finishValidJson()
    const { model, modelStart, modelEnd, stream } = this.metadata
    if (!model || modelStart === undefined || modelEnd === undefined || stream === undefined) {
      throw new Error('A valid Responses model is required.')
    }
    return { model, modelStart, modelEnd, stream }
  }

  finishValidJson(): void {
    this.utf8.decode()
    if (this.mode === 'number') {
      this.finishNumber()
    }
    if (this.mode !== 'normal' || this.frames.length !== 0 || this.root !== 'done') {
      throw new Error('The Responses request contains incomplete JSON.')
    }
  }

  private consume(byte: number): void {
    if (this.mode === 'string') {
      this.consumeString(byte)
      return
    }
    if (this.mode === 'number') {
      if (isCodexReplayNumberByte(byte)) {
        this.append(byte)
        return
      }
      this.finishNumber()
      this.consume(byte)
      return
    }
    if (this.mode === 'literal') {
      const expected = this.literal === 't' ? 'true' : this.literal === 'f' ? 'false' : 'null'
      if (byte !== expected.charCodeAt(this.capture.length)) {
        throw new Error('The Responses request contains invalid JSON.')
      }
      this.append(byte)
      if (this.capture.length === expected.length) {
        selectCodexReplayRoutingValue(
          this.selected,
          expected === 'true' ? true : expected === 'false' ? false : null,
          this.metadata
        )
        this.mode = 'normal'
        this.finishValue()
      }
      return
    }
    if (isSpace(byte)) {
      return
    }
    const frame = this.frames.at(-1)
    if (!frame) {
      if (this.root !== 'value' || byte !== 0x7b) {
        throw new Error('A Responses request must be one JSON object.')
      }
      this.pushObject()
      return
    }
    if (frame.kind === 'object') {
      this.consumeObject(frame, byte)
    } else {
      this.consumeArray(frame, byte)
    }
  }

  private consumeObject(frame: ObjectFrame, byte: number): void {
    if (frame.phase === 'key-or-end' && byte === 0x7d) {
      this.closeContainer()
      return
    }
    if (frame.phase === 'key-or-end' || frame.phase === 'key') {
      if (byte !== 0x22) {
        throw new Error('A JSON object key must be a string.')
      }
      this.beginString(true)
      return
    }
    if (frame.phase === 'colon') {
      if (byte !== 0x3a) {
        throw new Error('A JSON object key needs a colon.')
      }
      frame.phase = 'value'
      return
    }
    if (frame.phase === 'value') {
      this.beginValue(byte)
      return
    }
    if (byte === 0x2c) {
      frame.phase = 'key'
    } else if (byte === 0x7d) {
      this.closeContainer()
    } else {
      throw new Error('A JSON object needs a comma or closing brace.')
    }
  }

  private consumeArray(frame: ArrayFrame, byte: number): void {
    if (frame.phase === 'value-or-end' && byte === 0x5d) {
      this.closeContainer()
      return
    }
    if (frame.phase === 'value-or-end' || frame.phase === 'value') {
      this.beginValue(byte)
      return
    }
    if (byte === 0x2c) {
      frame.phase = 'value'
    } else if (byte === 0x5d) {
      this.closeContainer()
    } else {
      throw new Error('A JSON array needs a comma or closing bracket.')
    }
  }

  private beginValue(byte: number): void {
    const frame = this.frames.at(-1)
    this.selected =
      this.frames.length === 1 &&
      frame?.kind === 'object' &&
      (frame.key === 'model' || frame.key === 'stream' || frame.key === 'previous_response_id')
        ? frame.key
        : null
    if (this.selected) {
      if (this.seen.has(this.selected)) {
        throw new Error(`Duplicate Responses routing field: ${this.selected}.`)
      }
      this.seen.add(this.selected)
    }
    if (byte === 0x7b || byte === 0x5b) {
      if (this.selected) {
        throw new Error('A Responses routing field has an unsupported type.')
      }
      if (byte === 0x7b) {
        this.pushObject()
      } else {
        this.pushArray()
      }
      return
    }
    if (byte === 0x22) {
      this.beginString(false)
      return
    }
    if (byte === 0x74 || byte === 0x66 || byte === 0x6e) {
      this.mode = 'literal'
      this.literal = String.fromCharCode(byte)
      this.capture = [byte]
      this.captureLimit = 5
      return
    }
    if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) {
      this.mode = 'number'
      this.capture = [byte]
      this.captureLimit = MAX_NUMBER_BYTES
      return
    }
    throw new Error('The Responses request contains invalid JSON.')
  }

  private pushObject(): void {
    if (this.frames.length >= MAX_DEPTH) {
      throw new Error('Responses JSON nesting is too deep.')
    }
    this.frames.push({ kind: 'object', phase: 'key-or-end', key: null })
  }

  private pushArray(): void {
    if (this.frames.length >= MAX_DEPTH) {
      throw new Error('Responses JSON nesting is too deep.')
    }
    this.frames.push({ kind: 'array', phase: 'value-or-end' })
  }

  private closeContainer(): void {
    this.frames.pop()
    this.finishValue()
  }

  private finishValue(): void {
    const frame = this.frames.at(-1)
    if (!frame) {
      this.root = 'done'
    } else if (frame.kind === 'object' && frame.phase === 'value') {
      frame.phase = 'comma-or-end'
      frame.key = null
    } else if (
      frame.kind === 'array' &&
      (frame.phase === 'value-or-end' || frame.phase === 'value')
    ) {
      frame.phase = 'comma-or-end'
    } else {
      throw new Error('The Responses request contains invalid JSON structure.')
    }
    this.selected = null
  }

  private beginString(isKey: boolean): void {
    this.mode = 'string'
    this.string.begin(isKey, this.selected, this.position)
  }

  private consumeString(byte: number): void {
    const complete = this.string.consume(byte, this.position)
    if (!complete) {
      return
    }
    this.mode = 'normal'
    if (complete.isKey) {
      const frame = this.frames.at(-1)
      if (!frame || frame.kind !== 'object' || typeof complete.value !== 'string') {
        throw new Error('Invalid JSON key position.')
      }
      frame.key = complete.value
      frame.phase = 'colon'
    } else {
      selectCodexReplayRoutingValue(
        this.selected,
        complete.value,
        this.metadata,
        complete.start,
        complete.end
      )
      this.finishValue()
    }
  }

  private finishNumber(): void {
    const value = Buffer.from(this.capture).toString('ascii')
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
      throw new Error('The Responses request contains an invalid number.')
    }
    this.mode = 'normal'
    selectCodexReplayRoutingValue(this.selected, Number(value), this.metadata)
    this.finishValue()
  }

  private append(byte: number): void {
    if (this.captureLimit === 0) {
      return
    }
    if (this.capture.length >= this.captureLimit) {
      throw new Error('Responses routing metadata exceeds its bounded limit.')
    }
    this.capture.push(byte)
  }
}
