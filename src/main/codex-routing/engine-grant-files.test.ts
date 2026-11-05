import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as AccountFiles from '../codex-accounts/fs-utils'

const failure = vi.hoisted(() => ({ descriptorOnce: false }))
vi.mock('../codex-accounts/fs-utils', async () => {
  const actual = await vi.importActual<typeof AccountFiles>('../codex-accounts/fs-utils')
  return {
    ...actual,
    writeFileAtomically: (...args: Parameters<typeof actual.writeFileAtomically>) => {
      if (failure.descriptorOnce && args[0].endsWith('connection.json')) {
        failure.descriptorOnce = false
        throw new Error('synthetic descriptor disk failure')
      }
      return actual.writeFileAtomically(...args)
    }
  }
})
import { publishEngineGrant, readEngineGrantConnection } from './engine-grant-files'

let directory: string
const account = {
  id: '10000000-0000-4000-8000-000000000001',
  providerAccountId: 'provider-a',
  rosterRevision: 'r1'
}
const contents = (access: string) =>
  JSON.stringify({
    type: 'codex',
    account_id: 'provider-a',
    access_token: access,
    refresh_token: 'synthetic-refresh',
    id_token: `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'provider-a' } })).toString('base64url')}.synthetic`
  })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'opka-grant-rollback-'))
  failure.descriptorOnce = false
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('rolls back an interrupted two-file publication to the previous valid connection', () => {
  const previous = publishEngineGrant(directory, account, contents('synthetic-old'))
  failure.descriptorOnce = true
  expect(() => publishEngineGrant(directory, account, contents('synthetic-new'))).toThrow(
    /disk failure/
  )
  expect(readEngineGrantConnection(directory, account)).toEqual(previous)
  expect(readFileSync(join(directory, 'active-auth', previous.credentialId), 'utf8')).toContain(
    'synthetic-old'
  )
  expect(existsSync(join(directory, 'connections', account.id, 'activation.pending'))).toBe(false)
})

it('preserves a preexisting crash marker when recovery publication also fails', () => {
  publishEngineGrant(directory, account, contents('synthetic-old'))
  const marker = join(directory, 'connections', account.id, 'activation.pending')
  writeFileSync(marker, 'pending', { mode: 0o600 })
  failure.descriptorOnce = true
  expect(() => publishEngineGrant(directory, account, contents('synthetic-new'))).toThrow(
    /disk failure/
  )
  expect(existsSync(marker)).toBe(true)
  expect(readEngineGrantConnection(directory, account)).toBeNull()
})
