import { StringDecoder } from 'node:string_decoder'
import { createCodexStreamedRolloutRecord } from './codex-streamed-rollout-record'
import { closeSync, openSync, readSync, readdirSync, statSync, type Stats } from 'node:fs'

const TRANSCRIPT_READ_MAX_BYTES = 1024 * 1024
const TRANSCRIPT_LINE_MAX_BYTES = 256 * 1024
const TRANSCRIPT_DIRECTORY_MAX_ENTRIES = 4096

export type CodexTranscriptReadBudget = { remainingBytes: number; expiresAt?: number }

/** Resume point for an incremental read of one Codex rollout file. */
export type JsonlCursor = {
  filePath?: string
  offset: number
  carry: string
  decoder?: StringDecoder
  streamedRecord?: ReturnType<typeof createCodexStreamedRolloutRecord>
  verification?: {
    identity: string
    intact: boolean
    readable: boolean
    discardingLine: boolean
    terminated?: boolean
  }
}

export type JsonRecord = Record<string, unknown>

export function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

/** Returns undefined when the file is unreadable, distinguishing a vanished rollout from one with no new lines.
 *  `lineFilter` skips JSON.parse for raw lines the caller can reject by substring. */
export function readJsonlCursor(
  cursor: JsonlCursor,
  lineFilter?: (line: string) => boolean,
  options?: { incrementalHistory: true; budget?: CodexTranscriptReadBudget }
): JsonRecord[] | undefined {
  if (!cursor.filePath) {
    if (cursor.verification) {
      cursor.verification.readable = false
    }
    return undefined
  }
  let stats: Stats
  try {
    stats = statSync(cursor.filePath)
  } catch {
    if (cursor.verification) {
      cursor.verification.readable = false
    }
    return undefined
  }
  if (options?.incrementalHistory) {
    cursor.verification ??= {
      identity: `${stats.dev}:${stats.ino}`,
      intact: cursor.offset === 0,
      readable: false,
      discardingLine: false
    }
    if (
      cursor.verification.identity !== `${stats.dev}:${stats.ino}` ||
      stats.size < cursor.offset
    ) {
      cursor.verification.intact = false
    }
    cursor.verification.readable = stats.isFile()
  }
  if (!stats.isFile()) {
    return undefined
  }
  if (stats.size < cursor.offset) {
    cursor.offset = 0
    cursor.carry = ''
    cursor.decoder = undefined
    cursor.streamedRecord = undefined
  }
  if (stats.size === cursor.offset) {
    return []
  }
  if (options?.budget?.expiresAt !== undefined && performance.now() >= options.budget.expiresAt) {
    options.budget.remainingBytes = 0
  }
  const bytesToRead = Math.min(
    stats.size - cursor.offset,
    TRANSCRIPT_READ_MAX_BYTES,
    options?.budget?.remainingBytes ?? TRANSCRIPT_READ_MAX_BYTES
  )
  if (bytesToRead <= 0) {
    return []
  }
  const start =
    !options?.incrementalHistory && stats.size - cursor.offset > bytesToRead
      ? stats.size - bytesToRead
      : cursor.offset
  const buffer = Buffer.allocUnsafe(bytesToRead)
  let bytesRead = 0
  let fd: number | undefined
  try {
    fd = openSync(cursor.filePath, 'r')
    bytesRead = readSync(fd, buffer, 0, bytesToRead, start)
    if (options?.budget) {
      options.budget.remainingBytes -= bytesRead
    }
  } catch {
    if (cursor.verification) {
      cursor.verification.readable = false
    }
    return undefined
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
  const skippedPrefix = start !== cursor.offset
  if (cursor.verification && bytesRead > 0) {
    cursor.verification.terminated = buffer[bytesRead - 1] === 10
  }
  cursor.decoder ??= new StringDecoder('utf8')
  const content = cursor.decoder.write(buffer.subarray(0, bytesRead))
  const lines = content.split('\n')
  cursor.offset = start + bytesRead
  if (cursor.verification && skippedPrefix) {
    cursor.verification.intact = false
  }
  if (skippedPrefix) {
    cursor.carry = ''
    lines.shift()
  }
  const records: JsonRecord[] = []
  for (const [index, segment] of lines.entries()) {
    const complete = index < lines.length - 1
    if (cursor.verification?.discardingLine) {
      if (complete) {
        cursor.verification.discardingLine = false
      }
      continue
    }
    const line = `${cursor.carry}${segment}`
    cursor.carry = ''
    try {
      if (cursor.streamedRecord || Buffer.byteLength(line, 'utf8') > TRANSCRIPT_LINE_MAX_BYTES) {
        if (!cursor.verification) {
          continue
        }
        cursor.streamedRecord ??= createCodexStreamedRolloutRecord()
        cursor.streamedRecord.write(line)
        if (complete) {
          records.push(cursor.streamedRecord.end())
          cursor.streamedRecord = undefined
        }
      } else if (!complete) {
        cursor.carry = line
      } else if (!lineFilter || lineFilter(line)) {
        const parsed = record(JSON.parse(line) as unknown)
        if (parsed) {
          records.push(parsed)
        } else if (cursor.verification) {
          cursor.verification.intact = false
        }
      }
    } catch {
      cursor.streamedRecord = undefined
      if (cursor.verification) {
        cursor.verification.intact = false
        cursor.verification.discardingLine = !complete
      }
    }
  }
  return records
}

/** Metadata recheck prevents a prior EOF from certifying a transcript that has since advanced. */
export function jsonlCursorAtEnd(cursor: JsonlCursor): boolean {
  const evidence = cursor.verification
  if (
    !cursor.filePath ||
    !evidence?.readable ||
    evidence.discardingLine ||
    evidence.terminated === false ||
    cursor.streamedRecord ||
    cursor.carry
  ) {
    return false
  }
  try {
    const metadata = statSync(cursor.filePath)
    return (
      metadata.isFile() &&
      evidence.identity === `${metadata.dev}:${metadata.ino}` &&
      metadata.size === cursor.offset
    )
  } catch {
    return false
  }
}

export function verifyJsonlCursorHistory(cursor: JsonlCursor): boolean {
  return cursor.verification?.intact === true && jsonlCursorAtEnd(cursor)
}

export function readTranscriptDirectory(directory: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return []
  }
  if (entries.length > TRANSCRIPT_DIRECTORY_MAX_ENTRIES) {
    entries = entries.slice(-TRANSCRIPT_DIRECTORY_MAX_ENTRIES)
  }
  return entries
}
