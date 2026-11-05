import { lstatSync } from 'node:fs'
import { writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'
import { parseHooksJsonText } from '../agent-hooks/hooks-json-read'
import { isAddableHooksFile } from '../codex/codex-real-home-hooks-json'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import {
  createManagedCommandMatcher,
  readHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import {
  buildCodexManagedHook,
  CODEX_EVENT_LABEL,
  getCodexManagedHookInstallMaterial
} from '../codex/codex-hook-definition'
import { getCodexManagedScriptFileName } from '../codex/codex-hook-identity'
import { CODEX_HOOK_LAUNCH_WAIT_MS, lookupCodexHookAnswer } from '../codex/codex-hook-hash-lookup'
import { getInPlaceCodexHookHome } from '../codex/codex-hook-orca-approvals'
import {
  fingerprintCodex,
  type CodexHookAnswer,
  type CodexHookHashes
} from '../codex/codex-hook-trust-derivation'
import { reconcileCodexHookEntriesInHome } from '../codex/codex-real-home-hook-install'
import { runExclusivelyForCodexTrustConfig } from '../codex/codex-trust-config-mutation-queue'
import { computeTrustKey, readHookTrustEntries } from '../codex/config-toml-trust'

const FILE_BUDGET = 1024 * 1024

function assertOwnedInputs(home: string): void {
  const directory = lstatSync(home)
  if (
    !isAbsolute(home) ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((directory.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && directory.uid !== process.getuid())))
  ) {
    throw new Error('Native status hooks require a private owned routing HOME.')
  }
  for (const name of ['hooks.json', 'config.toml']) {
    try {
      const file = lstatSync(join(home, name))
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.nlink !== 1 ||
        file.size > FILE_BUDGET ||
        (process.platform !== 'win32' &&
          typeof process.getuid === 'function' &&
          file.uid !== process.getuid())
      ) {
        throw new Error('Native status hook configuration is linked, oversized or unverifiable.')
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }
}

function removeObsoleteMetadata(home: string): void {
  const path = join(home, 'hooks.json')
  let raw: string
  try {
    raw = readNodeFileSyncWithinLimit(path, FILE_BUDGET, {
      regularFileOnly: true,
      noFollow: true
    }).buffer.toString('utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw error
  }
  const config = parseHooksJsonText(raw)
  if (!config) {
    throw new Error('Native status hooks configuration could not be verified.')
  }
  const supported = { ...config }
  delete supported._managed
  if (!isAddableHooksFile(supported)) {
    throw new Error('Native status hooks have unsupported top-level fields or event layout.')
  }
  if (
    Object.hasOwn(config, '_managed') &&
    !writeFileAtomicallyIfUnchanged(path, raw, `${JSON.stringify(supported, null, 2)}\n`, {
      mode: 0o600
    })
  ) {
    throw new Error('Native status hooks changed during owned metadata cleanup.')
  }
}

function verifyInstalled(homePath: string, hashes: CodexHookHashes): void {
  const home = getInPlaceCodexHookHome(homePath)
  const material = getCodexManagedHookInstallMaterial()
  const config = readHooksJson(home.hooksJsonPath)
  const states = readHookTrustEntries(home.tomlPath)
  const isManaged = createManagedCommandMatcher(getCodexManagedScriptFileName())
  for (const eventName of material.events) {
    const entries = (config?.hooks?.[eventName] ?? []).flatMap((definition, groupIndex) =>
      (definition.hooks ?? []).flatMap((hook, handlerIndex) =>
        isManaged(hook.command) ? [{ hook, groupIndex, handlerIndex }] : []
      )
    )
    const entry = entries[0]
    if (
      entries.length !== 1 ||
      !entry ||
      !isDeepStrictEqual(entry.hook, buildCodexManagedHook(material.command, eventName))
    ) {
      throw new Error('Native canonical status hook installation could not be verified.')
    }
    const eventLabel = CODEX_EVENT_LABEL[eventName]
    for (const sourcePath of home.keySourcePaths) {
      const state = states.get(
        computeTrustKey({ sourcePath, eventLabel, ...entry, command: material.command })
      )
      if (state?.enabled !== true || state.trustedHash !== hashes[eventLabel]) {
        throw new Error('Native canonical status hook approval could not be verified.')
      }
    }
  }
  const script = readNodeFileSyncWithinLimit(material.scriptPath, FILE_BUDGET, {
    regularFileOnly: true,
    noFollow: true
  })
  if (script.buffer.toString('utf8') !== material.script) {
    throw new Error('Native canonical status script could not be verified.')
  }
}

/** Installs only in a caller-verified owned HOME, after its local API-key auth is prepared. */
export async function prepareNativeCodexStatusHooks(options: {
  home: string
  executable: string
  assertExclusive: () => void
  isEnabled: () => boolean
}): Promise<void> {
  const guard = () => {
    options.assertExclusive()
    if (!options.isEnabled()) {
      throw new Error('Native Codex automatic routing requires enabled status hooks.')
    }
    assertOwnedInputs(options.home)
    return true
  }
  guard()
  const before = fingerprintCodex(options.executable)
  if (!before || !isAbsolute(options.executable)) {
    throw new Error('The native Codex executable could not be verified.')
  }
  const material = getCodexManagedHookInstallMaterial()
  const answer = await withTimeout<CodexHookAnswer | null>(
    lookupCodexHookAnswer(options.executable, material.command),
    CODEX_HOOK_LAUNCH_WAIT_MS,
    null
  )
  guard()
  if (
    answer?.kind !== 'hashes' ||
    material.events.some((event) => {
      const hash = answer.hashes[CODEX_EVENT_LABEL[event]]
      return typeof hash !== 'string' || hash.length === 0
    })
  ) {
    throw new Error(
      'Native Codex status hook hashes are not ready or supported; retry after verification.'
    )
  }
  if (fingerprintCodex(options.executable) !== before) {
    throw new Error('The native Codex executable changed during status preparation.')
  }
  const home = getInPlaceCodexHookHome(options.home)
  await runExclusivelyForCodexTrustConfig(home.tomlPath, async () => {
    guard()
    removeObsoleteMetadata(options.home)
    guard()
    writeManagedScript(material.scriptPath, material.script)
    await reconcileCodexHookEntriesInHome(home, {
      hashes: answer.hashes,
      isEnabled: guard,
      convertOlderForms: true
    })
    guard()
    verifyInstalled(options.home, answer.hashes)
    if (fingerprintCodex(options.executable) !== before) {
      throw new Error('The native Codex executable changed during status preparation.')
    }
  })
}
