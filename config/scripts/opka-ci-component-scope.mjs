import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { runProcessSync } from '@orca/process-host'
import { isDirectInvocation } from './script-entry-detection.mjs'
import { findReusableQualification } from './opka-ci-qualification-proof.mjs'
import { findReusableFollowupProof, isFollowupProof } from './opka-ci-followup-proof.mjs'

export const CI_LANES = ['static', 'regression', 'desktop', 'electron', 'installers', 'android']
const allLanes = () => Object.fromEntries(CI_LANES.map((lane) => [lane, true]))

export function classifyCiPaths(paths) {
  const lanes = Object.fromEntries(CI_LANES.map((lane) => [lane, false]))
  lanes.static = true
  const reasons = new Set()
  let full = false
  const enable = (reason, names) => {
    reasons.add(reason)
    for (const name of names) {
      lanes[name] = true
    }
  }
  for (const path of paths) {
    if (/^(?:docs\/|fork-docs\/)|^(?:README|AGENTS|CONTRIBUTING|LICENSE)(?:\.md)?$/.test(path)) {
      continue
    }
    if (/^(?:config\/scripts|\.github\/scripts)\/[^/]+\.test\.mjs$/.test(path)) {
      enable('ci-contract-test', ['regression'])
    } else if (
      path === 'config/scripts/opka-release-qualification.mjs' ||
      path === 'config/scripts/opka-ci-component-scope.mjs'
    ) {
      enable('ci-admission-contract', ['regression'])
    } else if (
      /^config\/scripts\/opka[-_]android[^/]*\.py$/.test(path) ||
      path === 'config/scripts/build-android-update-handoff.py' ||
      path.startsWith('config/android-update-handoff/') ||
      path.startsWith('config/scripts/fixtures/android-webview-accessibility/')
    ) {
      enable('android-acceptance-driver', ['regression', 'android'])
    } else if (path.startsWith('mobile/')) {
      enable('mobile', ['regression'])
      if (!/\.(?:test|spec)\.[^/]+$/.test(path)) {
        enable('mobile-runtime', ['android'])
      }
    } else if (path.startsWith('src/renderer/')) {
      enable('renderer', ['regression', 'desktop', 'electron'])
    } else if (/^src\/(?:main|cli|preload|shared|packages)\//.test(path)) {
      enable('host-or-shared', ['regression', 'desktop', 'electron', 'installers', 'android'])
    } else if (path.startsWith('cloud/')) {
      enable('cloud', ['regression'])
    } else if (path.startsWith('tests/e2e/')) {
      enable('desktop-journey', ['regression', 'electron'])
      if (/packaged|installer/.test(path)) {
        enable('packaged-journey', ['installers'])
      }
    } else {
      full = true
      enable('build-policy-native-or-unknown', CI_LANES)
    }
  }
  return { ...lanes, full, docs_only: reasons.size === 0, reasons: [...reasons] }
}

export function evaluateCiResults(scope, needs) {
  if (!scope || needs.scope?.result !== 'success') {
    throw new Error('CI scope did not succeed')
  }
  if (Object.keys(needs).length !== CI_LANES.length + 1) {
    throw new Error('Unexpected CI dependency set')
  }
  if (scope.followupProof) {
    const proof = scope.followupProof
    if (
      !isFollowupProof(proof) ||
      proof.head !== scope.head ||
      proof.sourceTree !== scope.tree ||
      proof.base !== scope.base ||
      scope.reused !== false ||
      scope.static !== true ||
      scope.regression !== true ||
      CI_LANES.some((lane) => scope[lane] !== !proof.reusedLanes.includes(lane))
    ) {
      throw new Error('Invalid test-only follow-up qualification')
    }
  }
  for (const lane of CI_LANES) {
    const expected = scope.reused ? 'skipped' : scope[lane] ? 'success' : 'skipped'
    if (needs[lane]?.result !== expected) {
      throw new Error(`Unexpected ${lane} result; required ${expected}`)
    }
  }
}

function git(...args) {
  const result = runProcessSync({ program: 'git', args, timeoutMs: 120_000 })
  if (result.code !== 0) {
    throw new Error('Unable to resolve CI source inputs')
  }
  return result.stdout.trim()
}

export async function detectCiScope(env = process.env, findFollowup = findReusableFollowupProof) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  const head = git('rev-parse', 'HEAD')
  const tree = git('rev-parse', 'HEAD^{tree}')
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main') {
    try {
      const proof = await findReusableQualification({
        repository: env.GITHUB_REPOSITORY,
        token: env.GH_TOKEN,
        tree
      })
      if (proof) {
        return {
          ...Object.fromEntries(CI_LANES.map((lane) => [lane, false])),
          reused: true,
          comparison_valid: false,
          docs_only: false,
          head,
          tree,
          base: head,
          reasons: ['exact-tree-qualified-pr'],
          reusedRun: proof.runId
        }
      }
    } catch {
      // An unavailable proof never excuses a required check.
    }
  }
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    try {
      const proof = await findFollowup({
        repository: env.GITHUB_REPOSITORY,
        token: env.GH_TOKEN,
        event,
        head
      })
      if (
        isFollowupProof(proof) &&
        proof.head === head &&
        proof.sourceTree === tree &&
        proof.repository === env.GITHUB_REPOSITORY &&
        proof.prNumber === (event.number ?? event.pull_request?.number)
      ) {
        return {
          ...classifyCiPaths(proof.paths),
          ...Object.fromEntries(CI_LANES.map((lane) => [lane, !proof.reusedLanes.includes(lane)])),
          static: true,
          regression: true,
          reused: false,
          docs_only: false,
          comparison_valid: true,
          base: proof.base,
          head,
          tree,
          paths: proof.paths,
          followupProof: proof,
          reasons: [
            proof.kind === 'account-pool-readiness-followup'
              ? 'verified-account-pool-readiness-follow-up'
              : proof.kind === 'account-pool-readiness-android-followup'
                ? 'verified-account-pool-readiness-android-follow-up'
                : 'verified-test-only-follow-up'
          ]
        }
      }
    } catch {
      // Unverifiable component evidence keeps the normal required checks.
    }
  }
  try {
    const baseRef = env.GITHUB_EVENT_NAME === 'push' ? event.before : 'HEAD^1'
    if (
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' ||
      env.GITHUB_EVENT_NAME === 'workflow_call'
    ) {
      throw new Error('Manual full qualification')
    }
    if (env.GITHUB_EVENT_NAME === 'push') {
      if (!/^[a-f0-9]{40}$/.test(baseRef) || /^0+$/.test(baseRef)) {
        throw new Error('No push base')
      }
      git('fetch', '--no-tags', '--depth=1', 'origin', baseRef)
    }
    const base = git('rev-parse', baseRef)
    const result = runProcessSync({
      program: 'git',
      args: ['diff', '--name-only', '--no-renames', '-z', base, head, '--'],
      timeoutMs: 120_000
    })
    if (result.code !== 0) {
      throw new Error('No complete change list')
    }
    const paths = result.stdout.split('\0').filter(Boolean)
    return {
      ...classifyCiPaths(paths),
      comparison_valid: true,
      reused: false,
      base,
      head,
      tree,
      paths
    }
  } catch {
    return {
      ...allLanes(),
      reused: false,
      docs_only: false,
      base: head,
      head,
      tree,
      reasons: ['scope-unavailable-full'],
      full: true,
      comparison_valid: false
    }
  }
}

async function main() {
  mkdirSync('out/opka-ci', { recursive: true })
  if (process.argv.includes('--verify')) {
    const scope = JSON.parse(process.env.OPKA_CI_SCOPE)
    evaluateCiResults(scope, JSON.parse(process.env.OPKA_CI_RESULTS))
    writeFileSync(
      'out/opka-ci/qualification.json',
      `${JSON.stringify({
        schemaVersion: 1,
        tree: scope.tree,
        head: scope.head,
        runId: Number(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        event: process.env.GITHUB_EVENT_NAME,
        scope
      })}\n`
    )
    return
  }
  const scope = await detectCiScope()
  writeFileSync('out/opka-ci/scope.json', `${JSON.stringify(scope)}\n`)
  writeFileSync(
    'out/opka-ci/changed-paths.z',
    (scope.paths ?? []).map((path) => `${path}\0`).join('')
  )
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `plan=${JSON.stringify(scope)}\n${[
      ...CI_LANES,
      'docs_only',
      'reused',
      'base',
      'head',
      'full',
      'comparison_valid'
    ]
      .map((key) => `${key}=${scope[key] ?? false}\n`)
      .join('')}`
  )
  if (scope.followupProof) {
    const proof = scope.followupProof
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Reused successful ${proof.reusedLanes.join(', ')} checks from run ${proof.runId}, attempt ${proof.attempt}, source ${proof.base}; only reviewed test/CI inputs changed. Static and regression checks run on the current source.\n`
    )
  }
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `CI scope: ${scope.reused ? `reused successful exact-tree PR run ${scope.reusedRun}` : CI_LANES.filter((lane) => scope[lane]).join(', ')}. Reasons: ${(scope.reasons ?? []).join(', ') || 'documentation only'}.\n`
  )
}
if (isDirectInvocation(import.meta.url, process.argv[1])) {
  await main()
}
