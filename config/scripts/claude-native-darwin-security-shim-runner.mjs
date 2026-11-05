import { Buffer } from 'node:buffer'
import { spawnProcess } from '@orca/process-host'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

export const SECURITY_TRACE_SLOTS = 16
export const SECURITY_TRACE_SLOT_BYTES = 128
const OPERATIONS = new Map([
  ['find-generic-password', 'find'],
  ['-i', 'write'],
  ['add-generic-password', 'write'],
  ['delete-generic-password', 'delete'],
  ['show-keychain-info', 'info']
])
async function writeSlot(handle, record) {
  const text = JSON.stringify(record)
  if (Buffer.byteLength(text) > SECURITY_TRACE_SLOT_BYTES) {
    throw new Error('Security diagnostic record exceeded its fixed bound')
  }
  await handle.write(text, 0, 'utf8')
  await handle.truncate(Buffer.byteLength(text))
}
async function startSlot(directory, operation) {
  for (let slot = 0; slot < SECURITY_TRACE_SLOTS; slot++) {
    let handle
    try {
      handle = await open(join(directory, `${slot}.json`), 'wx', 0o600)
      await writeSlot(handle, { operation, started: true, finished: false, code: null })
      return handle
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error.code !== 'EEXIST') {
        return null
      }
    }
  }
  return null
}

/** This diagnostic never reads or captures the forwarded command's byte streams or arguments. */
export async function forwardSecurityDiagnostic({ program, args, traceDirectory }) {
  const operation = OPERATIONS.get(args[0]) ?? 'other'
  const slot = await startSlot(traceDirectory, operation)
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP']
  let child
  const forward = (signal) => {
    try {
      child?.kill(signal)
    } catch {}
  }
  const listeners = signals.map((signal) => {
    const listener = () => forward(signal)
    process.on(signal, listener)
    return [signal, listener]
  })
  let result
  try {
    result = await new Promise((resolve) => {
      try {
        child = spawnProcess({ program, args, stdio: 'inherit' })
        child.once('error', () => resolve({ code: 127, signal: null }))
        child.once('close', (code, signal) => resolve({ code, signal }))
      } catch {
        resolve({ code: 127, signal: null })
      }
    })
    return result
  } finally {
    for (const [signal, listener] of listeners) {
      process.removeListener(signal, listener)
    }
    if (slot) {
      try {
        await writeSlot(slot, {
          operation,
          started: true,
          finished: true,
          code: result?.code ?? null
        })
      } catch {}
      await slot.close().catch(() => {})
    }
  }
}

export async function readSecurityDiagnosticTrace(directory) {
  const records = []
  let unverifiable = false
  for (let slot = 0; slot < SECURITY_TRACE_SLOTS; slot++) {
    let handle
    try {
      handle = await open(
        join(directory, `${slot}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW
      )
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > SECURITY_TRACE_SLOT_BYTES) {
        throw new Error('Invalid diagnostic slot')
      }
      const value = JSON.parse(await handle.readFile('utf8'))
      if (
        !['find', 'write', 'delete', 'info', 'other'].includes(value.operation) ||
        value.started !== true ||
        typeof value.finished !== 'boolean' ||
        !(
          value.code === null ||
          (Number.isInteger(value.code) && value.code >= 0 && value.code <= 255)
        )
      ) {
        throw new Error('Invalid diagnostic record')
      }
      records.push({
        operation: value.operation,
        started: true,
        finished: value.finished,
        code: value.code
      })
    } catch (error) {
      if (error.code !== 'ENOENT') {
        unverifiable = true
      }
    } finally {
      await handle?.close().catch(() => {})
    }
  }
  return {
    records,
    capacityReached: records.length === SECURITY_TRACE_SLOTS,
    unverifiable: unverifiable || records.length === 0
  }
}
