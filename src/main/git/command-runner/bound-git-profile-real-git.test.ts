import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { runProcess, spawnProcess } from '@orca/process-host'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import type { GitLabNetworkProfile } from '../../../shared/gitlab-network-profile'
import { readRepoGitAuthor, updateRepoGitAuthor } from '../repo-git-author'
import { prepareBoundGitClone } from './bound-git-clone'
import { validateBoundGitCloneSelection } from './bound-git-clone-selection'
import { runBoundGitNetworkCommand } from './bound-git-network-executor'
import type { execFileCapture, execFileCaptureToTermination } from './exec-file-capture'

const capture = vi.hoisted(() => vi.fn())
vi.mock('./exec-file-capture', async (importOriginal) => ({
  ...(await importOriginal<{
    execFileCapture: typeof execFileCapture
    execFileCaptureToTermination: typeof execFileCaptureToTermination
  }>()),
  execFileCaptureToTermination: capture
}))

type AuthorizedRequest = { repo: 'a' | 'b'; user: string }
let root = ''
let closeServer: () => Promise<void> = async () => {}

async function command(program: string, args: string[], cwd: string): Promise<string> {
  const result = await runProcess({ program, args, cwd, timeoutMs: 20_000 })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Synthetic ${program} fixture command failed`)
  }
  return result.stdout.trim()
}

async function backend(
  request: IncomingMessage,
  response: ServerResponse,
  bareRoot: string,
  pathInfo: string,
  user: string,
  query: string
): Promise<void> {
  const child = spawnProcess({
    program: 'git',
    args: ['http-backend'],
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: bareRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: query,
      REQUEST_METHOD: request.method ?? 'GET',
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      CONTENT_LENGTH: request.headers['content-length'] ?? '0',
      HTTP_GIT_PROTOCOL:
        typeof request.headers['git-protocol'] === 'string' ? request.headers['git-protocol'] : '',
      REMOTE_USER: user
    },
    stdio: 'pipe'
  })
  const chunks: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.stderr.resume()
  child.stdin.on('error', () => {})
  request.pipe(child.stdin)
  const deadline = setTimeout(() => child.kill(), 20_000)
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (value) => resolve(value ?? 1))
  }).finally(() => clearTimeout(deadline))
  const output = Buffer.concat(chunks)
  const crlf = output.indexOf('\r\n\r\n')
  const lf = crlf === -1 ? output.indexOf('\n\n') : -1
  const boundary = crlf !== -1 ? crlf : lf
  if (code !== 0 || boundary === -1) {
    throw new Error('Synthetic Git HTTP backend failed')
  }
  const headers: Record<string, string> = {}
  let status = 200
  for (const line of output.subarray(0, boundary).toString('utf8').split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) {
      continue
    }
    const name = line.slice(0, separator)
    const value = line.slice(separator + 1).trim()
    if (name.toLowerCase() === 'status') {
      status = Number.parseInt(value, 10)
    } else {
      headers[name] = value
    }
  }
  response.writeHead(status, headers)
  response.end(output.subarray(boundary + (crlf !== -1 ? 4 : 2)))
}

async function fixtureServer(
  bareRoot: string,
  cert: string,
  key: string,
  tokens: Record<'a' | 'b', { user: string; password: string }>,
  requests: AuthorizedRequest[]
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(
    { cert: await readFile(cert), key: await readFile(key) },
    (req, res) => {
      const target = new URL(req.url ?? '/', 'https://127.0.0.1')
      const match = /^\/(a|b)\.git(?:\/|$)/.exec(target.pathname)
      if (!match || (match[1] !== 'a' && match[1] !== 'b')) {
        res.writeHead(404).end()
        return
      }
      const repo = match[1]
      const expected = `Basic ${Buffer.from(`${tokens[repo].user}:${tokens[repo].password}`).toString('base64')}`
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="synthetic-git"' }).end()
        return
      }
      requests.push({ repo, user: tokens[repo].user })
      void backend(
        req,
        res,
        bareRoot,
        target.pathname,
        tokens[repo].user,
        target.search.slice(1)
      ).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500)
        }
        res.end()
      })
    }
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Synthetic server address unavailable')
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

async function launcher(directory: string): Promise<string> {
  const entry = join(directory, 'credential-entry.ts')
  const output = join(directory, 'credential-launcher.cjs')
  const source = resolve(import.meta.dirname, '../../../cli/internal-git-credential.ts')
  await writeFile(
    entry,
    `import { runInternalGitCredentialCli } from ${JSON.stringify(source)}\n` +
      `if (process.argv[2] !== 'internal-git-credential') process.exit(1)\n` +
      `void runInternalGitCredentialCli(process.argv.slice(3))\n`
  )
  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    banner: { js: `#!${process.execPath}` },
    logLevel: 'silent'
  })
  await chmod(output, 0o700)
  return output
}

async function seedBare(bareRoot: string, name: 'a' | 'b'): Promise<void> {
  const bare = join(bareRoot, `${name}.git`)
  const seed = join(root, `seed-${name}`)
  await mkdir(seed)
  await command('git', ['init', '--bare', '-q', bare], root)
  await command('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], bare)
  await command('git', ['config', 'http.receivepack', 'true'], bare)
  await command('git', ['init', '-q'], seed)
  await command('git', ['config', '--local', 'user.name', 'Seed'], seed)
  await command('git', ['config', '--local', 'user.email', 'seed@example.test'], seed)
  await writeFile(join(seed, 'README.md'), `seed ${name}\n`)
  await command('git', ['add', 'README.md'], seed)
  await command('git', ['commit', '-q', '-m', 'seed'], seed)
  await command('git', ['push', bare, 'HEAD:main'], seed)
}

afterEach(async () => {
  capture.mockReset()
  vi.unstubAllEnvs()
  await closeServer()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = ''
  closeServer = async () => {}
})

describe.skipIf(process.platform === 'win32')('bound Git profiles with real disposable Git', () => {
  it('keeps two profile credentials and two local commit authors separate through clone, push and fetch', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-bound-real-git-'))
    const bareRoot = join(root, 'bare')
    await mkdir(bareRoot)
    const globalConfig = join(root, 'global.gitconfig')
    const ambientMarker = join(root, 'ambient-helper-used')
    const ambientHelper = join(root, 'ambient-helper.sh')
    await writeFile(
      ambientHelper,
      `#!/bin/sh\nprintf x >> ${quotePosixShell(ambientMarker)}\nexit 1\n`
    )
    await chmod(ambientHelper, 0o700)
    await writeFile(
      globalConfig,
      `[user]\nname = Ambient\nemail = ambient@example.test\n[credential]\nhelper = !${quotePosixShell(ambientHelper)}\n`
    )
    const globalBefore = await readFile(globalConfig, 'utf8')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    for (const name of ['a', 'b'] as const) {
      await seedBare(bareRoot, name)
    }

    const tlsConfig = join(root, 'tls.cnf')
    const key = join(root, 'key.pem')
    const cert = join(root, 'cert.pem')
    await writeFile(
      tlsConfig,
      '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n'
    )
    await command(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-config',
        tlsConfig
      ],
      root
    )
    const requests: AuthorizedRequest[] = []
    const tokens = {
      a: { user: 'alice', password: 'synthetic-alice' },
      b: { user: 'bob', password: 'synthetic-bob' }
    }
    const server = await fixtureServer(bareRoot, cert, key, tokens, requests)
    closeServer = server.close
    const host = `127.0.0.1:${server.port}`
    const profiles: GitLabNetworkProfile[] = (['a', 'b'] as const).map((name) => ({
      id: name.repeat(64),
      host,
      user: tokens[name].user,
      generation:
        name === 'a'
          ? '00000000-0000-4000-8000-000000000001'
          : '00000000-0000-4000-8000-000000000002'
    }))
    const tokenByProfileId = new Map(
      profiles.map((profile, index) => [profile.id, tokens[index === 0 ? 'a' : 'b'].password])
    )
    const profileStore = {
      list: () => profiles,
      readToken: (profile: GitLabNetworkProfile) => {
        const token = tokenByProfileId.get(profile.id)
        if (!token) {
          throw new Error('Synthetic profile unavailable')
        }
        return token
      }
    }
    const launcherPath = await launcher(root)
    const actual = await vi.importActual<{
      execFileCaptureToTermination: typeof execFileCaptureToTermination
    }>('./exec-file-capture')
    capture.mockImplementation(
      (
        gitBinary: string,
        args: string[],
        options: Parameters<typeof actual.execFileCaptureToTermination>[2]
      ) => {
        // Test-local CA trust only on real network children; product preflight remains untouched.
        const network = args[0] === '-c'
        return actual.execFileCaptureToTermination(
          gitBinary,
          network ? ['-c', `http.sslCAInfo=${cert}`, ...args] : args,
          options
        )
      }
    )

    for (const name of ['a', 'b'] as const) {
      const url = `https://${host}/${name}.git`
      const target = join(root, `clone-${name}`)
      await mkdir(target)
      const stat = await lstat(target)
      const profile = profiles.find((entry) => entry.id === name.repeat(64))
      if (!profile) {
        throw new Error('Synthetic profile unavailable')
      }
      const selection = await validateBoundGitCloneSelection(
        url,
        { provider: 'gitlab', profileId: profile.id },
        { profileStore, launcherPath }
      )
      const clone = await prepareBoundGitClone({
        url,
        destination: root,
        clonePath: target,
        selection,
        claimedTarget: {
          canCleanup: true,
          ownedDirectoryIdentity: { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }
        }
      })
      const beforeClone = requests.length
      try {
        expect(clone.args.join(' ')).not.toContain(tokens[name].password)
        await actual.execFileCaptureToTermination(
          'git',
          ['-c', `http.sslCAInfo=${cert}`, ...clone.args],
          {
            cwd: root,
            env: clone.env,
            timeout: 20_000,
            terminationBarrier: true
          }
        )
      } finally {
        await clone.close()
      }
      expect(requests.slice(beforeClone)).toEqual(
        expect.arrayContaining([{ repo: name, user: tokens[name].user }])
      )
      expect(
        requests
          .slice(beforeClone)
          .every((request) => request.repo === name && request.user === tokens[name].user)
      ).toBe(true)

      const repo = { id: name, path: target, kind: 'git' as const }
      const author =
        name === 'a'
          ? { name: 'Alice Author', email: 'alice@example.test' }
          : { name: 'Bob Author', email: 'bob@example.test' }
      await updateRepoGitAuthor(repo, {
        ...author,
        expectedLocalName: null,
        expectedLocalEmail: null
      })
      expect((await readRepoGitAuthor(repo)).name.local).toBe(author.name)
      const hookMarker = join(root, `hook-${name}`)
      const hook = join(target, '.git', 'hooks', 'pre-commit')
      await writeFile(hook, `#!/bin/sh\nprintf x >> ${quotePosixShell(hookMarker)}\n`)
      await chmod(hook, 0o700)
      await writeFile(join(target, `change-${name}.txt`), `change ${name}\n`)
      await command('git', ['add', `change-${name}.txt`], target)
      await command('git', ['commit', '-q', '-m', `change ${name}`], target)
      expect(await readFile(hookMarker, 'utf8')).toBe('x')
      expect(await command('git', ['log', '-1', '--format=%an <%ae>'], target)).toBe(
        `${author.name} <${author.email}>`
      )

      const commonGitDir = join(target, '.git')
      for (const operation of ['push', 'fetch'] as const) {
        const identity = {
          operation,
          repoId: name,
          worktreeId: `worktree-${name}`,
          worktreePath: target,
          commonGitDir,
          remoteName: 'origin',
          executionHostId: 'local',
          connectionGeneration: 'synthetic-local',
          profileId: profile.id,
          profileGeneration: profile.generation,
          profileHost: host,
          username: profile.user
        }
        const beforeOperation = requests.length
        await runBoundGitNetworkCommand(
          operation === 'push'
            ? ['push', '--set-upstream', 'origin', 'HEAD:main']
            : ['fetch', '--prune', 'origin'],
          { cwd: target, env: process.env },
          {
            identity,
            launcherPath,
            readCurrentIdentity: async () => identity,
            readPassword: async () => profileStore.readToken(profile)
          }
        )
        expect(requests.slice(beforeOperation)).toEqual(
          expect.arrayContaining([{ repo: name, user: tokens[name].user }])
        )
        expect(
          requests
            .slice(beforeOperation)
            .every((request) => request.repo === name && request.user === tokens[name].user)
        ).toBe(true)
      }
      expect(
        await command(
          'git',
          ['--git-dir', join(bareRoot, `${name}.git`), 'log', '-1', '--format=%an <%ae>', 'main'],
          root
        )
      ).toBe(`${author.name} <${author.email}>`)
    }
    expect(existsSync(ambientMarker)).toBe(false)
    expect(await readFile(globalConfig, 'utf8')).toBe(globalBefore)
  }, 90_000)
})
