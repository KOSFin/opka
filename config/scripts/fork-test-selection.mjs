import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { collectUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import { selectUnitFiles } from './ci-unit-selection.mjs'
import { discoverUnitFiles } from './ci-unit-files.mjs'
import ts from 'typescript-api'

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

export function selectForkTests(files, changed, graph, fallbackFiles) {
  // Fork qualification retains its approved indirect-input coverage, not every upstream opaque reader.
  const directGraph = () => ({
    ...(typeof graph === 'function' ? graph() : graph),
    opaque: new Set()
  })
  const selected = selectUnitFiles(files, changed, directGraph, {
    sourcePrefixes: ['src/', 'mobile/src/', 'mobile/app/', 'mobile/scripts/', 'mobile/packages/']
  })
  const covered = selected.full
    ? (fallbackFiles ?? files)
    : [...(fallbackFiles ?? []), ...selected.files]
  return {
    ...selected,
    reason: selected.full
      ? selected.reason
      : 'Approved fork qualification plus transitive consumers',
    files: [...new Set([...covered, ...files.filter((file) => changed.includes(file))])].sort()
  }
}

export function forkGraphFailureReason(error) {
  if (error instanceof Error) {
    const match = /^No public orca-source export for (@orca\/[a-z0-9_./-]+)$/.exec(error.message)
    if (match) {
      return `Dependency graph unavailable (missing-source:${match[1]})`
    }
    return `Dependency graph unavailable (${error.name === 'Error' ? 'Error' : 'UnexpectedError'})`
  }
  return 'Dependency graph unavailable (UnknownError)'
}

export function splitForkTestLanes(files, readSource = (file) => readFileSync(file, 'utf8')) {
  const lanes = { root: [], mobile: [], render: [], node: [] }
  for (const file of new Set(files)) {
    const imports = file.endsWith('.mjs')
      ? ts.preProcessFile(readSource(file), true, true).importedFiles.map((entry) => entry.fileName)
      : []
    if (imports.includes('node:test')) {
      if (imports.includes('vitest')) {
        throw new Error(`A test cannot mix Node and Vitest runners: ${file}`)
      }
      lanes.node.push(file)
    } else if (file.startsWith('mobile/')) {
      lanes.mobile.push(file)
    } else if (file.endsWith('-render.test.mjs')) {
      lanes.render.push(file)
    } else {
      lanes.root.push(file)
    }
  }
  return lanes
}

function saveForkTestSelection(plan, root) {
  const directory = join(root, 'out', 'opka-ci')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'fork-test-selection.json'), JSON.stringify(plan, null, 2))
  return plan
}

export function prepareForkTestSelection(request, root = process.cwd(), baselineFilters = []) {
  const files = [
    ...discoverUnitFiles(root),
    ...globSync(
      ['mobile/src/**/*.test.ts', 'mobile/src/**/*.test.tsx', 'mobile/scripts/**/*.test.ts'],
      { cwd: root, exclude: ['**/node_modules/**'] }
    ).map((file) => file.replaceAll('\\', '/'))
  ].sort()
  const fallbackFiles = files.filter((file) =>
    baselineFilters.some((filter) => file.includes(filter))
  )
  if (!fallbackFiles.length) {
    throw new Error('Approved fork fallback inventory is empty')
  }
  const split = (selected) =>
    splitForkTestLanes(selected, (file) => readFileSync(join(root, file), 'utf8'))
  if (!request) {
    return saveForkTestSelection(
      {
        schema: 1,
        discoveredCount: files.length,
        fallbackCount: fallbackFiles.length,
        files: fallbackFiles,
        full: true,
        reason: 'Approved fork qualification',
        lanes: split(fallbackFiles)
      },
      root
    )
  }
  const { base, head } = request
  const checkout = runProcessSync({ program: 'git', args: ['rev-parse', 'HEAD'], cwd: root })
  if (checkout.code !== 0 || checkout.stdout.trim() !== head) {
    throw new Error('Changed test plan HEAD must match the tested checkout')
  }
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
      () => collectUnitDependencyGraph(root, { includeMobile: true }),
      fallbackFiles
    )
  } catch (error) {
    selection = {
      files: [
        ...new Set([...fallbackFiles, ...files.filter((file) => changed.includes(file))])
      ].sort(),
      full: true,
      reason: forkGraphFailureReason(error)
    }
  }
  const plan = {
    schema: 1,
    discoveredCount: files.length,
    fallbackCount: fallbackFiles.length,
    base,
    head,
    changed,
    ...selection,
    lanes: split(selection.files)
  }
  return saveForkTestSelection(plan, root)
}
