import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeDurableText(file: string, value: string): void {
  const descriptor = openSync(file, 'wx', 0o600)
  try {
    writeFileSync(descriptor, value)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  const parent = openSync(dirname(file), 'r')
  try {
    fsyncSync(parent)
  } finally {
    closeSync(parent)
  }
}

export function writeDurableJson(file: string, value: unknown): void {
  writeDurableText(file, JSON.stringify(value))
}
