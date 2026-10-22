import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const libraryNames = ['ManifestAPI', 'PluginAPI']

function compilerBuild(file) {
  return readFileSync(file, 'utf8').match(
    /^\/\/ swift-compiler-version:.*\((swiftlang-[^ ]+)/m
  )?.[1]
}

export function stalePrivateInterfaces(root) {
  const stale = new Set()
  for (const name of libraryNames) {
    const directory = path.join(root, name)
    if (!existsSync(directory)) {
      continue
    }
    for (const relative of readdirSync(directory, { recursive: true })) {
      if (!relative.endsWith('.private.swiftinterface')) {
        continue
      }
      const privatePath = path.join(directory, relative)
      const publicPath = privatePath.replace('.private.swiftinterface', '.swiftinterface')
      if (!existsSync(publicPath)) {
        continue
      }
      const publicBuild = compilerBuild(publicPath)
      const privateBuild = compilerBuild(privatePath)
      if (publicBuild && privateBuild && publicBuild !== privateBuild) {
        stale.add(privatePath)
      }
    }
  }
  return stale
}

/** Isolate mixed CLT interfaces; never edit the installed Apple toolchain. */
export function withSwiftPmLibraries(callback, options = {}) {
  const env = options.env ?? process.env
  if (env.SWIFTPM_CUSTOM_LIBS_DIR) {
    return callback(env)
  }
  let source = options.source
  if (!source) {
    const swift = spawnSync('xcrun', ['--find', 'swift'], { encoding: 'utf8', env })
    if (swift.status !== 0) {
      throw new Error('Cannot locate the selected Swift toolchain')
    }
    source = path.resolve(path.dirname(swift.stdout.trim()), '../lib/swift/pm')
  }
  const stale = stalePrivateInterfaces(source)
  if (stale.size === 0) {
    return callback(env)
  }
  const scratch = mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), 'orca-swiftpm-'))
  try {
    for (const name of libraryNames) {
      const directory = path.join(source, name)
      if (existsSync(directory)) {
        cpSync(directory, path.join(scratch, name), {
          recursive: true,
          filter: (entry) => !stale.has(entry)
        })
      }
    }
    console.log(`[swiftpm] Isolated ${stale.size} stale private interfaces; system files unchanged`)
    return callback({ ...env, SWIFTPM_CUSTOM_LIBS_DIR: scratch })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
