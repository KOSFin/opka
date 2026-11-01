import { MobileWebBundleManifestResultSchema } from '../../src/shared/mobile-web-bundle/bundle-rpc-contract.ts'
import { pairMobileClient } from '../../tests/e2e/helpers/paired-mobile-client.ts'
/** Synthetic real-host fixture. Bundle with esbuild; never runs against an installed profile. */
import { spawnProcess, runProcessSync } from '@orca/process-host'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { RuntimeClient } from '../../src/cli/runtime/client.ts'
import { projectTaskTemplate } from '../../src/shared/project-task-template.ts'
import { decodePairingOffer, encodePairingOffer } from '../../src/shared/pairing.ts'
import {
  ORCAD_SERVER_ENTRY_FILENAME,
  orcadNodeRuntimeRelativePath
} from '../../src/shared/orcad-artifacts.ts'
import { NODE_RUNTIME_ASSETS } from '../../src/shared/node-runtime-pin.ts'
import { getE2ECompletedOnboardingProfile } from '../../tests/e2e/helpers/e2e-completed-onboarding-profile.ts'
import {
  parseHeadlessPairedRuntimePairingOffer,
  HeadlessPairedRuntimeStartupDiagnosticBuffer
} from '../../tests/e2e/helpers/headless-paired-runtime-serve-readiness.ts'
import { currentTarget } from './server-build-target.mjs'

if (process.platform !== 'linux' || process.env.CI !== 'true') {
  throw new Error('This fixture runs only on an isolated Linux CI runner')
}
const argument = (name) => process.argv[process.argv.indexOf(name) + 1]
const readyFile = process.argv.includes('--ready-file') ? resolve(argument('--ready-file')) : null
const summaryFile = process.argv.includes('--summary-file')
  ? resolve(argument('--summary-file'))
  : null
if (!readyFile || !summaryFile) {
  throw new Error('Pass --ready-file (private) and --summary-file (evidence)')
}
const root = resolve(process.cwd())
const scratch = mkdtempSync(join(tmpdir(), 'opka-android-ui-'))
const profile = join(scratch, 'profile')
const home = join(scratch, 'home')
const projectRoot = join(scratch, 'synthetic-integration')
for (const directory of [profile, home, projectRoot, dirname(readyFile), dirname(summaryFile)]) {
  mkdirSync(directory, { recursive: true })
}
chmodSync(scratch, 0o700)
const seedProfile = getE2ECompletedOnboardingProfile()
seedProfile.settings.telemetry.optedIn = false
writeFileSync(join(profile, 'orca-data.json'), JSON.stringify(seedProfile), { mode: 0o600 })
const serverRoot = join(root, 'out', 'orcad')
const childEnv = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  LANG: 'C.UTF-8',
  ORCA_BACKGROUND_LAUNCH: '1',
  ORCA_USER_DATA: profile
}
const child = spawnProcess({
  program: join(
    serverRoot,
    ...orcadNodeRuntimeRelativePath(
      currentTarget(),
      NODE_RUNTIME_ASSETS[currentTarget()].executableSha256
    )
  ),
  args: [
    join(serverRoot, ORCAD_SERVER_ENTRY_FILENAME),
    '--port',
    '0',
    '--json',
    '--bind',
    '127.0.0.1',
    '--pairing-address',
    '10.0.2.2',
    '--mobile-pairing'
  ],
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true
})
const stderr = new HeadlessPairedRuntimeStartupDiagnosticBuffer()
child.stderr.on('data', (chunk) => stderr.append(chunk))
let ownedReadyFile = false
let closing = false
const watchdog = setTimeout(() => void close(1), 15 * 60_000)
async function close(code) {
  if (closing) {
    return
  }
  closing = true
  clearTimeout(watchdog)
  child.kill('SIGTERM')
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((done) => child.once('exit', done)),
      new Promise((done) => setTimeout(done, 10_000))
    ])
  }
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
  if (ownedReadyFile) {
    rmSync(readyFile, { force: true })
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  process.exitCode = code
}
process.once('SIGTERM', () => void close(0))
process.once('SIGINT', () => void close(0))
function waitForOffer() {
  return new Promise((done, fail) => {
    let pending = ''
    const timer = setTimeout(
      () => fail(new Error(`Real host did not become ready: ${stderr.read()}`)),
      120_000
    )
    child.once('error', fail)
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`Fixture host exited (${code}): ${stderr.read()}`))
    })
    child.stdout.on('data', (chunk) => {
      pending += String(chunk)
      let newline
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const offer = parseHeadlessPairedRuntimePairingOffer(line)
        if (offer) {
          clearTimeout(timer)
          done(offer)
        }
      }
      if (pending.length > 65_536) {
        pending = ''
      }
    })
  })
}
function git(directory, ...args) {
  const reply = runProcessSync({
    program: 'git',
    args,
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8' },
    timeoutMs: 15_000,
    maxOutputBytes: 65536
  })
  if (reply.code !== 0) {
    throw new Error(`Synthetic git ${args[0]} failed`)
  }
}
try {
  const offer = await waitForOffer()
  const decoded = decodePairingOffer(offer.pairingUrl)
  if (decoded.scope !== 'mobile' || new URL(decoded.endpoint).hostname !== '10.0.2.2') {
    throw new Error('Fixture offer must be emulator-local and mobile-scoped')
  }
  // The local CLI owner is isolated too; its default ambient source fence must not target another app.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ORCA_') || key === 'CODEX_HOME' || key === 'CLAUDE_CONFIG_DIR') {
      delete process.env[key]
    }
  }
  const loopback = new URL(decoded.endpoint)
  loopback.hostname = '127.0.0.1'
  const phoneProbe = pairMobileClient({
    pairingUrl: encodePairingOffer({ ...decoded, endpoint: loopback.toString() })
  })
  let servedBuildId
  try {
    const served = MobileWebBundleManifestResultSchema.parse(
      await phoneProbe.call('mobileWeb.bundle.manifest')
    )
    const built = JSON.parse(readFileSync(join(root, 'out', 'mobile-web', 'manifest.json'), 'utf8'))
    if (served.manifest.buildId !== built.buildId) {
      throw new Error('Real host serves a different mobile page build than the candidate source')
    }
    servedBuildId = served.manifest.buildId
  } finally {
    phoneProbe.dispose()
  }
  const client = new RuntimeClient(profile, 15_000, null, null)
  const call = async (method, params) => (await client.call(method, params)).result
  const groupResult = z
    .object({ group: z.object({ id: z.string() }) })
    .parse(
      await call('projectGroup.create', { name: 'Synthetic integration', parentPath: projectRoot })
    )
  for (const name of ['client', 'service']) {
    const directory = join(projectRoot, name)
    mkdirSync(directory)
    writeFileSync(join(directory, 'README.md'), `# Synthetic ${name}\n`)
    git(directory, 'init')
    git(directory, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git(directory, 'config', 'user.name', 'Synthetic QA')
    git(directory, 'config', 'user.email', 'qa@example.invalid')
    git(directory, 'add', 'README.md')
    git(directory, 'commit', '-m', 'Synthetic fixture')
    const added = z
      .object({ repo: z.object({ id: z.string() }) })
      .parse(await call('repo.add', { path: directory, displayName: name }))
    await call('repo.update', {
      repo: `id:${added.repo.id}`,
      updates: { projectGroupId: groupResult.group.id }
    })
  }
  const folder = z.object({ folderWorkspace: z.object({ id: z.string() }) }).parse(
    await call('folderWorkspace.create', {
      projectGroupId: groupResult.group.id,
      name: 'Project session',
      folderPath: projectRoot
    })
  )
  const worktree = `folder:${folder.folderWorkspace.id}`
  const target = z
    .object({ executionHostId: z.string() })
    .parse(await call('projectTask.target', { worktree }))
  await call('projectTask.init', { worktree, expectedExecutionHostId: target.executionHostId })
  await call('projectTask.create', {
    worktree,
    expectedExecutionHostId: target.executionHostId,
    source: 'project',
    slug: 'native-qa-starter',
    content: projectTaskTemplate({
      id: 'task-11111111-1111-4111-8111-111111111111',
      title: 'Native QA starter',
      goal: 'Verify the synthetic UI without agents or network services.'
    })
  })
  const catalog = z
    .object({ projects: z.array(z.object({ name: z.string(), selector: z.string() })) })
    .parse(await call('projectTask.catalog'))
  const project = catalog.projects.find(
    (entry) =>
      entry.selector === worktree ||
      entry.name === 'Synthetic integration' ||
      entry.name === 'Project session'
  )
  if (!project) {
    throw new Error('Real synthetic project was not discoverable in mobile catalog')
  }
  writeFileSync(
    summaryFile,
    JSON.stringify(
      {
        schema: 1,
        realHost: true,
        mobileWebBuildId: servedBuildId,
        realMobileScopeManifestProbe: true,
        syntheticOnly: true,
        pairingScope: decoded.scope,
        transport: 'loopback through emulator10.0.2.2',
        projectName: project.name,
        repos: ['client', 'service'],
        tasks: ['Native QA starter'],
        accountCredentialsSeeded: false,
        providerNetworkAccessNeeded: false
      },
      null,
      2
    )
  )
  writeFileSync(
    readyFile,
    JSON.stringify({ schema: 1, pairingUrl: offer.pairingUrl, projectName: project.name }),
    { mode: 0o600, flag: 'wx' }
  )
  ownedReadyFile = true
  process.stdout.write(
    'Synthetic real-host Android UI fixture ready; private pairing file created.\n'
  )
  if (process.argv.includes('--check')) {
    await close(0)
  }
} catch (error) {
  process.stderr.write(
    `Fixture failed: ${error instanceof Error ? error.message : 'Unknown failure'}\n`
  )
  await close(1)
}
