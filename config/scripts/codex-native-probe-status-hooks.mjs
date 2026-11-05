import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, lstat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { getCodexManagedHookInstallMaterial } from '../../src/main/codex/codex-hook-definition.ts'
import { getCodexHookTrustMemoPath } from '../../src/main/codex/codex-hook-trust-memo.ts'
import {
  lookupCodexHookAnswer,
  startCodexHookHashLookup
} from '../../src/main/codex/codex-hook-hash-lookup.ts'
import { listCodexHooks } from '../../src/main/codex/codex-hook-trust-derivation.ts'
import { prepareNativeCodexStatusHooks } from '../../src/main/codex-routing/native-codex-status-hooks.ts'

/** Only the fake probe environment enables lookup; production prep never starts a global sweep. */
export async function prepareNativeProbeStatusHooks({ root, home, executable, report }) {
  if (!process.argv.includes('--canonical-status')) {
    return
  }
  process.env.ORCA_USER_DATA_PATH = join(root, 'app')
  const material = getCodexManagedHookInstallMaterial()
  if (
    !material.scriptPath.startsWith(`${root}${sep}`) ||
    !getCodexHookTrustMemoPath().startsWith(`${root}${sep}`)
  ) {
    throw new Error('Canonical hook fixture escaped private fake profile')
  }
  const temporary = join(root, 'hook-qualification-tmp')
  await mkdir(temporary, { mode: 0o700 })
  const previous = process.env.TMPDIR
  let scratchAuth
  process.env.TMPDIR = temporary
  try {
    scratchAuth = await inheritedScratchAuth(root, executable, report)
    startCodexHookHashLookup(Promise.resolve())
    const answer = await lookupCodexHookAnswer(executable, material.command)
    if (answer.kind !== 'hashes') {
      throw new Error('Actual pinned native executable did not qualify canonical hook hashes')
    }
    await scratchAuth?.verify()
    await prepareNativeCodexStatusHooks({
      home,
      executable,
      assertExclusive: () => {},
      isEnabled: () => true
    })
    report.canonicalStatusPreparation = {
      actualNativeHashLookup: true,
      selfComputedFallback: false,
      codexVersion: answer.codexVersion,
      events: Object.keys(answer.hashes).length,
      privateFakeProfile: true
    }
  } finally {
    await scratchAuth?.stop()
    if (previous === undefined) {
      delete process.env.TMPDIR
    } else {
      process.env.TMPDIR = previous
    }
  }
}

async function inheritedScratchAuth(root, executable, report) {
  if (!process.argv.includes('--inherited-scratch-auth')) {
    return null
  }
  let requests = 0
  const trap = createServer((request, response) => {
    requests++
    request.resume()
    response
      .writeHead(400, { 'content-type': 'application/json' })
      .end('{"error":"synthetic_identity_denied"}')
  })
  trap.listen(0, '127.0.0.1')
  await once(trap, 'listening')
  const keys = ['CODEX_ACCESS_TOKEN', 'CODEX_AUTHAPI_BASE_URL', 'CODEX_SQLITE_HOME']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const stop = async () => {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previous[key]
      }
    }
    trap.closeAllConnections()
    await new Promise((done) => trap.close(done))
  }
  try {
    process.env.CODEX_ACCESS_TOKEN = 'at-synthetic-hook-scratch-only-not-a-real-credential'
    process.env.CODEX_AUTHAPI_BASE_URL = `http://127.0.0.1:${trap.address().port}`
    const calibration = join(root, 'pat-calibration')
    await mkdir(calibration, { mode: 0o700 })
    // The existing explicit-home operation intentionally retains caller auth; it proves the trap is live.
    await listCodexHooks(executable, calibration, calibration).catch(() => {})
    const baseline = requests
    const foreign = join(root, 'forbidden-inherited-sqlite')
    process.env.CODEX_SQLITE_HOME = foreign
    report.scratchAuthEnvironment = {
      syntheticPat: true,
      calibrationRequests: baseline,
      additionalRequests: null,
      parentUnchanged: null,
      foreignSqliteAbsent: null
    }
    return {
      async verify() {
        const evidence = report.scratchAuthEnvironment
        evidence.additionalRequests = requests - baseline
        evidence.parentUnchanged =
          process.env.CODEX_ACCESS_TOKEN === 'at-synthetic-hook-scratch-only-not-a-real-credential'
        try {
          await lstat(foreign)
          evidence.foreignSqliteAbsent = false
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error
          }
          evidence.foreignSqliteAbsent = true
        }
        if (
          baseline < 1 ||
          evidence.additionalRequests !== 0 ||
          !evidence.parentUnchanged ||
          !evidence.foreignSqliteAbsent
        ) {
          throw new Error('Scratch-only auth/environment isolation failed')
        }
      },
      stop
    }
  } catch (error) {
    await stop()
    throw error
  }
}
