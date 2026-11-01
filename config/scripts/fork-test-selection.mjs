import { globSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { collectUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import { selectUnitFiles } from './ci-unit-selection.mjs'
import { discoverUnitFiles } from './ci-unit-files.mjs'

export function parseForkSelectionArgs(args) {
  if (args[0] === '--') {
    args = args.slice(1)
  }
  if (!args.length) {
    return null
  }
  if (
    args.length !== 3 ||
    args[0] !== '--changed' ||
    !args.slice(1).every((ref) => /^[a-f0-9]{40}$/.test(ref))
  ) {
    throw new Error('Expected --changed BASE_SHA HEAD_SHA with immutable 40-character commits')
  }
  return { base: args[1], head: args[2] }
}

export function selectForkTests(files, changed, graph) {
  return selectUnitFiles(files, changed, graph, {
    sourcePrefixes: ['src/', 'mobile/src/', 'mobile/app/', 'mobile/scripts/', 'mobile/packages/']
  })
}

export function splitForkTestLanes(files) {
  return {
    root: files.filter((file) => !file.startsWith('mobile/') && !file.endsWith('-render.test.mjs')),
    mobile: files.filter((file) => file.startsWith('mobile/')),
    render: files.filter((file) => !file.startsWith('mobile/') && file.endsWith('-render.test.mjs'))
  }
}

export function prepareForkTestSelection({ base, head }, root = process.cwd()) {
  const checkout = runProcessSync({ program: 'git', args: ['rev-parse', 'HEAD'], cwd: root })
  if (checkout.code !== 0 || checkout.stdout.trim() !== head) {
    throw new Error('Changed test plan HEAD must match the tested checkout')
  }
  const files = [
    ...discoverUnitFiles(root),
    ...globSync(
      ['mobile/src/**/*.test.ts', 'mobile/src/**/*.test.tsx', 'mobile/scripts/**/*.test.ts'],
      { cwd: root, exclude: ['**/node_modules/**'] }
    ).map((file) => file.replaceAll('\\', '/'))
  ].sort()
  const diff = runProcessSync({
    program: 'git',
    args: ['diff', '--name-only', '--no-renames', '-z', base, head],
    cwd: root,
    maxOutputBytes: 16 * 1024 * 1024
  })
  const changed = diff.code === 0 && !diff.timedOut ? diff.stdout.split('\0').filter(Boolean) : []
  let selection
  try {
    selection = selectForkTests(
      files,
      changed,
      collectUnitDependencyGraph(root, { includeMobile: true })
    )
  } catch {
    selection = { files, full: true, reason: 'Dependency graph unavailable' }
  }
  const plan = {
    schema: 1,
    base,
    head,
    changed,
    ...selection,
    lanes: splitForkTestLanes(selection.files)
  }
  const directory = join(root, 'out', 'opka-ci')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'fork-test-selection.json'), JSON.stringify(plan, null, 2))
  return plan
}
