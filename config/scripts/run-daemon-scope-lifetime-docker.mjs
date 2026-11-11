import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const docker =
  process.env.ORCA_DOCKER ??
  (existsSync('/Applications/Docker.app/Contents/Resources/bin/docker')
    ? '/Applications/Docker.app/Contents/Resources/bin/docker'
    : 'docker')
const dockerDirectory = dirname(docker)
const dockerEnv = {
  ...process.env,
  ORCA_BACKGROUND_LAUNCH: '1',
  ...(dockerDirectory !== '.'
    ? { PATH: `${dockerDirectory}${delimiter}${process.env.PATH ?? ''}` }
    : {})
}
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--baseline' || !args[1] || args[1].startsWith('-')) {
  throw new Error('Usage: run-daemon-scope-lifetime-docker.mjs --baseline <git-ref>')
}
const baselineRef = args[1]
const dockerDir = join(repo, 'config/docker/daemon-scope-lifetime')
const temp = mkdtempSync(join(tmpdir(), 'orca-daemon-scope-lifetime-'))
const suffix = `${process.pid}-${Date.now()}`
const image = `orca-daemon-scope-lifetime:${suffix}`
const container = `orca-daemon-scope-lifetime-${suffix}`
const platform =
  process.env.ORCA_DOCKER_PLATFORM ?? (process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64')

function runDocker(command, allowFailure = false) {
  const result = spawnSync(docker, command, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: dockerEnv
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 && !allowFailure) {
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`docker ${command[0]} failed with ${result.status}`)
  }
  return result
}

async function bundle(mode) {
  const productionScopePath = join(repo, 'src/main/daemon/daemon-cgroup-scope.ts')
  const baselineSource =
    mode === 'baseline'
      ? execFileSync('git', ['show', `${baselineRef}:src/main/daemon/daemon-cgroup-scope.ts`], {
          cwd: repo,
          encoding: 'utf8'
        })
      : null
  await build({
    ...(mode === 'candidate'
      ? { entryPoints: [join(dockerDir, 'bundle-entry.ts')] }
      : {
          stdin: {
            contents:
              "export { buildDurableDaemonScopeCommand } from './src/main/daemon/daemon-cgroup-scope'",
            resolveDir: repo,
            loader: 'ts'
          }
        }),
    bundle: true,
    platform: 'node',
    external: ['electron'],
    format: 'cjs',
    target: 'node22',
    outfile: join(temp, `${mode}.cjs`),
    logLevel: 'warning',
    plugins:
      baselineSource === null
        ? []
        : [
            {
              name: 'baseline-daemon-scope',
              setup(buildApi) {
                buildApi.onLoad({ filter: /daemon-cgroup-scope\.ts$/ }, ({ path }) =>
                  path === productionScopePath
                    ? { contents: baselineSource, loader: 'ts', resolveDir: dirname(path) }
                    : undefined
                )
              }
            }
          ]
  })
}

// Why three releases: OOMPolicy on scopes is rejected by systemd 249 (Ubuntu 22.04), accepted by
// Debian's 252 and native from 253 (Debian 13's 257).
const baseImages = (
  process.env.ORCA_DAEMON_SCOPE_BASE_IMAGES ??
  'ubuntu:22.04,debian:bookworm-slim,debian:trixie-slim'
).split(',')
const artifactDirectory = process.env.ORCA_DAEMON_SCOPE_ARTIFACT_DIR

function recordCase(baseImage, name, result) {
  if (artifactDirectory) {
    mkdirSync(artifactDirectory, { recursive: true })
    const imageName = baseImage.replace(/[^a-z0-9]+/gi, '-')
    writeFileSync(
      join(artifactDirectory, `${imageName}-${name}.log`),
      `exit=${result.status}\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`
    )
  }
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
}

let agentReportCasePending = true

function runCases(baseImage) {
  runDocker([
    'build',
    '--platform',
    platform,
    '--build-arg',
    `BASE_IMAGE=${baseImage}`,
    '-t',
    image,
    dockerDir
  ])
  if (artifactDirectory) {
    const imageName = baseImage.replace(/[^a-z0-9]+/gi, '-')
    const identity = runDocker(['image', 'inspect', '--format', '{{.Id}}', image])
    const baseDigests = runDocker(
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', baseImage],
      true
    )
    mkdirSync(artifactDirectory, { recursive: true })
    writeFileSync(
      join(artifactDirectory, `${imageName}-image.txt`),
      `candidateImageId=${identity.stdout.trim()}\nbaseImage=${baseImage}\nbaseRepoDigests=${baseDigests.status === 0 ? baseDigests.stdout.trim() : 'unavailable'}\n`
    )
  }
  runDocker([
    'run',
    '--detach',
    '--name',
    container,
    '--platform',
    platform,
    '--privileged',
    '--cgroupns=host',
    '--security-opt',
    'label=disable',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/run/lock',
    '-v',
    '/sys/fs/cgroup:/sys/fs/cgroup:rw',
    '-e',
    'ORCA_BACKGROUND_LAUNCH=1',
    image
  ])
  runDocker(['cp', `${temp}/.`, `${container}:/opt/daemon-scope-lifetime/`])
  runDocker([
    'exec',
    container,
    '/bin/sh',
    '-c',
    [
      'systemctl start systemd-logind.service',
      'loginctl enable-linger orca-repro',
      'systemctl start user@1100.service',
      'test -S /run/user/1100/bus'
    ].join(' && ')
  ])
  for (const mode of ['baseline', 'candidate']) {
    const result = runDocker(
      [
        'exec',
        container,
        'timeout',
        '--kill-after=5s',
        '240s',
        'runuser',
        '-u',
        'orca-repro',
        '--',
        'env',
        'XDG_RUNTIME_DIR=/run/user/1100',
        'ORCA_BACKGROUND_LAUNCH=1',
        'node',
        '/opt/daemon-scope-lifetime/run-cases.cjs',
        `/opt/daemon-scope-lifetime/${mode}.cjs`,
        mode
      ],
      true
    )
    recordCase(baseImage, mode, result)
    if (result.status !== 0) {
      throw new Error(`${mode} scope lifetime oracle failed on ${baseImage} with ${result.status}`)
    }
  }
  const stateRoot = `/tmp/orca-automation-case-${suffix}`
  for (const [name, script, timeout] of [
    ['automation-prepare', 'automation-command-cases.cjs', '90s'],
    ['automation-store-prepare', 'automation-command-store-prepare.cjs', '30s'],
    ['automation-store-recover', 'automation-command-store-restart.cjs', '30s'],
    ['automation-recover', 'automation-command-restart.cjs', '30s']
  ]) {
    const automation = runDocker(
      [
        'exec',
        container,
        'timeout',
        '--kill-after=5s',
        timeout,
        'runuser',
        '-u',
        'orca-repro',
        '--',
        'env',
        'XDG_RUNTIME_DIR=/run/user/1100',
        'ORCA_BACKGROUND_LAUNCH=1',
        'node',
        `/opt/daemon-scope-lifetime/${script}`,
        '/opt/daemon-scope-lifetime/candidate.cjs',
        stateRoot
      ],
      true
    )
    recordCase(baseImage, name, automation)
    if (automation.status !== 0) {
      throw new Error(`${name} scope oracle failed on ${baseImage} with ${automation.status}`)
    }
  }
  if (agentReportCasePending) {
    const agentReport = runDocker(
      [
        'exec',
        container,
        'timeout',
        '--kill-after=5s',
        '90s',
        'runuser',
        '-u',
        'orca-repro',
        '--',
        'env',
        'XDG_RUNTIME_DIR=/run/user/1100',
        'ORCA_BACKGROUND_LAUNCH=1',
        'node',
        '/opt/daemon-scope-lifetime/automation-command-agent-report.cjs',
        '/opt/daemon-scope-lifetime/candidate.cjs',
        `${stateRoot}-agent-report`
      ],
      true
    )
    recordCase(baseImage, 'automation-agent-report', agentReport)
    if (agentReport.status !== 0) {
      throw new Error(`automation-agent-report scope oracle failed on ${baseImage}`)
    }
    agentReportCasePending = false
  }
}

try {
  await bundle('baseline')
  await bundle('candidate')
  for (const baseImage of baseImages) {
    console.log(`== ${baseImage}`)
    try {
      runCases(baseImage)
    } finally {
      runDocker(['rm', '--force', container], true)
    }
  }
  console.log(
    'Linux systemd scope lifetime oracle passed: baseline accumulates orphans; candidate reaps them; live and unrelated work survives; each terminal is its own scope.'
  )
} finally {
  runDocker(['rm', '--force', container], true)
  runDocker(['image', 'rm', image], true)
  rmSync(temp, { recursive: true, force: true })
}
