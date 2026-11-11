/** Canonical HTTPS authority for a selected Git network identity. IPv6 literals are unsupported. */
export function normalizeGitHttpsHost(value: string): string | null {
  if (
    !value ||
    value !== value.trim() ||
    /[\s\\/@%?#]/.test(value) ||
    value.includes('[') ||
    value.includes(']') ||
    [...value].some((character) => character.charCodeAt(0) < 0x20 || character === '\u007f')
  ) {
    return null
  }
  const parts = value.split(':')
  if (parts.length > 2) {
    return null
  }
  const [hostname, port] = parts
  if (
    !hostname ||
    hostname.endsWith('.') ||
    (port !== undefined && !/^[1-9][0-9]{0,4}$/.test(port))
  ) {
    return null
  }
  if (port !== undefined && Number(port) > 65535) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(`https://${value}/`)
  } catch {
    return null
  }
  const canonical = parsed.hostname
  if (
    parsed.protocol !== 'https:' ||
    parsed.pathname !== '/' ||
    parsed.username ||
    parsed.password ||
    !canonical ||
    canonical.endsWith('.') ||
    canonical.length > 253 ||
    canonical.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return null
  }
  if (
    [...hostname].every((character) => character.charCodeAt(0) <= 0x7f) &&
    hostname.toLowerCase() !== canonical
  ) {
    return null
  }
  if (/^[0-9.]+$/.test(canonical)) {
    const octets = canonical.split('.')
    if (
      octets.length !== 4 ||
      octets.some((octet) => !/^(0|[1-9][0-9]{0,2})$/.test(octet) || Number(octet) > 255)
    ) {
      return null
    }
  }
  return parsed.port ? `${canonical}:${parsed.port}` : canonical
}
