import { open, constants } from 'node:fs/promises'

const CATEGORIES = {
  refreshCasSaveFailed: /OAuth refresh CAS save failed/i,
  tokenSaveFailed: /Failed to save OAuth tokens|tokens save failed/i,
  keychainWriteFailed:
    /keychain.{0,100}(?:write|save|add).{0,100}(?:fail|error)|(?:write|save|add).{0,100}keychain.{0,100}(?:fail|error)/i,
  credentialWriteFailed: /credential.{0,100}(?:write|save).{0,100}(?:fail|error)/i,
  lockCompromised: /(?:refresh|credential).{0,100}lock.{0,100}compromised/i,
  refreshFailed: /OAuth refresh failed|Token refresh failed/i,
  profileFetchFailed: /Failed to fetch oauth profile/i,
  fileWriteFailed: /(?:write|rename|mkdir|chmod).{0,100}(?:EACCES|EPERM|EROFS|EIO)/i
}
export async function readNativeRefreshDiagnosticSummary(file) {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) {
      return { unavailable: true }
    }
    const buffer = Buffer.alloc(65536)
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      Math.max(0, info.size - buffer.length)
    )
    const lines = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => !/request.?body|"(?:access_token|refresh_token)"|\[Request/i.test(line))
    const text = lines.join('\n')
    return {
      unavailable: false,
      bytes: info.size,
      truncated: info.size > buffer.length,
      categories: Object.fromEntries(
        Object.entries(CATEGORIES).map(([name, pattern]) => [name, pattern.test(text)])
      ),
      errorCodes: [
        ...new Set(text.match(/\b(?:EACCES|EPERM|ENOENT|EEXIST|EROFS|EIO|ETIMEDOUT)\b/g) ?? [])
      ]
    }
  } catch {
    return { unavailable: true }
  } finally {
    await handle?.close()
  }
}
export function summarizeNativeRefreshCommand(text) {
  try {
    const value = JSON.parse(text.trim().split('\n').at(-1) ?? '')
    return {
      bytes: Buffer.byteLength(text),
      json: true,
      isError: value.is_error === true,
      subtype: [
        'success',
        'error_during_execution',
        'error_max_turns',
        'error_max_budget_usd'
      ].includes(value.subtype)
        ? value.subtype
        : 'unknown'
    }
  } catch {
    return { bytes: Buffer.byteLength(text), json: false }
  }
}
