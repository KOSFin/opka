import { normalizeCodexTrustProjectPath } from '../codex/codex-trust-identity'

export function nativeHomeProjectTrustEntries(
  value: unknown
): { path: string; normalized: string; level: unknown; data: unknown }[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return []
  }
  return Object.entries(value).map(([path, entry]) => ({
    path,
    normalized: normalizeCodexTrustProjectPath(path),
    level: entry && typeof entry === 'object' && 'trust_level' in entry ? entry.trust_level : null,
    data: entry
  }))
}
