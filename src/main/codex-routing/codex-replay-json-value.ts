export type CodexReplayRoutingKey = 'model' | 'stream' | 'previous_response_id'

export type CodexReplayMetadata = {
  model: string
  modelStart: number
  modelEnd: number
  stream: boolean
}

const MAX_KEY_BYTES = 1024
const MAX_ROUTING_STRING_BYTES = 4096

export const isCodexReplayNumberByte = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) ||
  byte === 0x2d ||
  byte === 0x2b ||
  byte === 0x2e ||
  byte === 0x65 ||
  byte === 0x45

const isHex = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66)

/** Parses one JSON string while retaining only bounded keys and routing values. */
export class CodexReplayJsonString {
  private capture: number[] = []
  private captureLimit = 0
  private escaped = false
  private unicodeDigits = 0
  private start = 0
  private isKey = false

  begin(isKey: boolean, selected: CodexReplayRoutingKey | null, position: number): void {
    this.isKey = isKey
    this.escaped = false
    this.unicodeDigits = 0
    this.start = position
    this.capture = isKey || selected ? [0x22] : []
    this.captureLimit = isKey ? MAX_KEY_BYTES : selected ? MAX_ROUTING_STRING_BYTES : 0
  }

  consume(
    byte: number,
    position: number
  ): { isKey: boolean; value: unknown; start: number; end: number } | null {
    if (this.captureLimit > 0) {
      if (this.capture.length >= this.captureLimit) {
        throw new Error('Responses routing metadata exceeds its bounded limit.')
      }
      this.capture.push(byte)
    }
    if (this.unicodeDigits > 0) {
      if (!isHex(byte)) {
        throw new Error('A JSON string has an invalid Unicode escape.')
      }
      this.unicodeDigits--
      return null
    }
    if (this.escaped) {
      this.escaped = false
      if (byte === 0x75) {
        this.unicodeDigits = 4
      } else if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(byte)) {
        throw new Error('A JSON string has an invalid escape.')
      }
      return null
    }
    if (byte === 0x5c) {
      this.escaped = true
      return null
    }
    if (byte === 0x22) {
      return {
        isKey: this.isKey,
        value: this.captureLimit ? JSON.parse(Buffer.from(this.capture).toString('utf8')) : null,
        start: this.start,
        end: position + 1
      }
    }
    if (byte < 0x20) {
      throw new Error('A JSON string contains a control character.')
    }
    return null
  }
}

export function selectCodexReplayRoutingValue(
  selected: CodexReplayRoutingKey | null,
  value: unknown,
  metadata: Partial<CodexReplayMetadata>,
  start?: number,
  end?: number
): void {
  if (selected === 'model') {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 200 ||
      start === undefined ||
      end === undefined
    ) {
      throw new Error('A valid Responses model is required.')
    }
    metadata.model = value
    metadata.modelStart = start
    metadata.modelEnd = end
  } else if (selected === 'stream') {
    if (typeof value !== 'boolean') {
      throw new Error('Responses stream must be a boolean.')
    }
    metadata.stream = value
  } else if (selected === 'previous_response_id' && value !== null) {
    throw new Error('This transport requires the complete local conversation history.')
  }
}
