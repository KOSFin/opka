import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { createClaudeNativeAccessFacade } from './claude-native-access-facade'

function inventory(root: string) {
  const paths: string[] = [],
    inodes = new Set<string>()
  let fileBytes = 0,
    allocatedFileBytes = 0,
    allocatedDirectoryBytes = 0,
    files = 0,
    links = 0
  const walk = (path: string) => {
    const stat = lstatSync(path)
    paths.push(
      `${relative(root, path)}:${stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file'}`
    )
    if (stat.isSymbolicLink()) {
      links++
    } else if (stat.isDirectory()) {
      allocatedDirectoryBytes += stat.blocks * 512
      for (const name of readdirSync(path).sort()) {
        walk(join(path, name))
      }
    } else {
      files++
      const key = `${stat.dev}:${stat.ino}`
      if (!inodes.has(key)) {
        inodes.add(key)
        fileBytes += stat.size
        allocatedFileBytes += stat.blocks * 512
      }
    }
  }
  walk(root)
  return {
    paths,
    files,
    links,
    uniqueFiles: inodes.size,
    fileBytes,
    allocatedFileBytes,
    allocatedDirectoryBytes
  }
}

it.runIf(process.platform === 'linux')(
  'keeps the full shared-history facade tree bounded across 1000 atomic account publications',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'opka-claude-facade-disk-'))
    const userHome = join(root, 'user'),
      defaults = join(userHome, '.claude'),
      project = join(defaults, 'projects', 'synthetic-project')
    mkdirSync(project, { recursive: true })
    const transcript = join(project, 'synthetic-session.jsonl'),
      history = join(defaults, 'history.jsonl'),
      settings = join(defaults, 'settings.json'),
      sourceState = join(userHome, '.claude.json')
    const transcriptBytes =
      `${JSON.stringify({ type: 'user', message: 'synthetic history only' })}\n`.repeat(1024)
    writeFileSync(transcript, transcriptBytes)
    writeFileSync(history, '{"display":"synthetic","timestamp":1}\n')
    writeFileSync(settings, '{"model":"sonnet","effortLevel":"high","mcpServers":{"synthetic":{}}}')
    writeFileSync(sourceState, '{"theme":"dark","customPreference":{"keep":true}}')
    const originalSettings = readFileSync(settings),
      originalState = readFileSync(sourceState),
      originalHistory = readFileSync(history),
      originalTranscript = statSync(transcript)
    const pair = (id: string) => ({
      access: {
        accessToken: `synthetic-${id}`,
        expiresAt: 4_000_000_000_000,
        scopes: ['user:inference']
      },
      identity: {
        accountUuid: id,
        organizationUuid: `org-${id}`,
        emailAddress: `${id}@example.invalid`
      }
    })
    let exclusive = true
    const assertExclusive = () => {
      if (!exclusive) {
        throw new Error('Synthetic fixture ownership lost.')
      }
    }
    try {
      const facade = await createClaudeNativeAccessFacade({
        dataRoot: join(root, 'data'),
        sessionId: randomUUID(),
        userHome,
        target: { executionHostId: 'local', runtime: 'host' },
        snapshot: pair('A'),
        assertExclusive,
        platform: 'linux'
      })
      const ownState = join(facade.home, '.claude.json'),
        initialState = JSON.parse(readFileSync(ownState, 'utf8')),
        { oauthAccount: _initialIdentity, ...preferences } = initialState
      const baseline = inventory(root),
        samples: ReturnType<typeof inventory>[] = []
      for (let count = 1; count <= 1000; count++) {
        await facade.publish(pair(count % 2 ? 'B' : 'A'), () => true)
        if (count % 250 !== 0) {
          continue
        }
        const sample = inventory(root)
        samples.push(sample)
        expect(sample.paths).toEqual(baseline.paths)
        expect(sample.files).toBe(baseline.files)
        expect(sample.links).toBe(baseline.links)
        expect(sample.uniqueFiles).toBe(baseline.uniqueFiles)
        expect(sample.fileBytes).toBe(baseline.fileBytes)
        expect(sample.allocatedFileBytes).toBe(baseline.allocatedFileBytes)
        expect(sample.paths.some((path) => /pending|guarded|\.tmp|\.merge/.test(path))).toBe(false)
        const shared = statSync(
          join(facade.home, 'projects', 'synthetic-project', 'synthetic-session.jsonl')
        )
        expect([shared.dev, shared.ino]).toEqual([originalTranscript.dev, originalTranscript.ino])
        expect(readFileSync(transcript, 'utf8')).toBe(transcriptBytes)
        expect(readFileSync(history)).toEqual(originalHistory)
        expect(readFileSync(settings)).toEqual(originalSettings)
        expect(readFileSync(sourceState)).toEqual(originalState)
        const { oauthAccount, ...currentPreferences } = JSON.parse(readFileSync(ownState, 'utf8'))
        expect(currentPreferences).toEqual(preferences)
        expect(oauthAccount).toEqual(pair('A').identity)
      }
      const metrics = ({ paths: _paths, ...sizes }: ReturnType<typeof inventory>) => sizes
      expect(new Set(samples.map((sample) => sample.allocatedDirectoryBytes)).size).toBe(1)
      console.info('Synthetic production Claude facade disk samples', {
        baseline: metrics(baseline),
        samples: samples.map(metrics)
      })
      // No native process was ever launched; this fixture exclusively owns the disposable facade.
      await facade.dispose()
      exclusive = false
      expect(existsSync(facade.home)).toBe(false)
      expect(readFileSync(transcript, 'utf8')).toBe(transcriptBytes)
      expect(readFileSync(history)).toEqual(originalHistory)
      expect(readFileSync(settings)).toEqual(originalSettings)
      expect(readFileSync(sourceState)).toEqual(originalState)
      const saved = JSON.parse(
        readFileSync(
          join(root, 'data', 'native-cli-preferences', 'claude', 'preferences.json'),
          'utf8'
        )
      )
      expect(saved.state).toEqual(preferences)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  30_000
)
