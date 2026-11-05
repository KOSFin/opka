import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it as vitestIt } from 'vitest'
import {
  refreshClaudeNativeAccess,
  type ClaudeNativeRefreshSource
} from './claude-native-refresh-authority'
const it = vitestIt.skipIf(process.platform !== 'linux'),
  roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
it('clears a real durable pending writer after proven missing native spawn and admits the next actual process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opka-refresh-never-started-'))
  roots.push(root)
  const identity = {
    accountUuid: 'fake-account',
    organizationUuid: 'fake-org',
    emailAddress: 'fake@example.invalid'
  }
  const source = (name: string, command: string, args: string[]): ClaudeNativeRefreshSource => {
    const configDir = join(root, name),
      writerDirectory = join(configDir, 'writer')
    mkdirSync(configDir, { mode: 0o700 })
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: identity }), {
      mode: 0o600
    })
    writeFileSync(
      join(configDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fake-source-AT',
          refreshToken: 'fake-source-RT',
          expiresAt: Date.now() + 3600000,
          scopes: ['user:inference']
        }
      }),
      { mode: 0o600 }
    )
    return {
      configDir,
      writerDirectory,
      expectedIdentity: identity,
      launch: { command, args, cwd: configDir },
      qualifiedVersion: '2.1.318',
      assertExclusive: () => {
        if (!existsSync(root)) {
          throw new Error('Synthetic profile ownership lost')
        }
      }
    }
  }
  const failed = source('missing', join(root, 'missing-native-claude'), [])
  await expect(refreshClaudeNativeAccess(failed)).rejects.toThrow('did not produce')
  expect(existsSync(join(failed.writerDirectory, 'writer-owner.json'))).toBe(false)
  expect(existsSync(join(failed.writerDirectory, 'writer-owner.json.next'))).toBe(false)
  const script = join(root, 'synthetic-no-model.mjs')
  writeFileSync(
    script,
    'process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false})+"\\n")\n',
    { mode: 0o600 }
  )
  const next = source('actual-child', process.execPath, [script])
  await expect(refreshClaudeNativeAccess(next)).resolves.toMatchObject({
    identity,
    access: { accessToken: 'fake-source-AT' }
  })
  expect(existsSync(join(next.writerDirectory, 'writer-owner.json'))).toBe(false)
  expect(existsSync(join(next.writerDirectory, 'writer-owner.json.next'))).toBe(false)
}, 15000)
