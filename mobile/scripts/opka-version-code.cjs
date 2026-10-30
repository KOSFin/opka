module.exports = function opkaVersionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)-rc\.([1-9]\d*)$/.exec(version ?? '')
  if (!match) {
    throw new Error('Opka Android requires an explicit beta version')
  }
  const [major, minor, patch, rc] = match.slice(1).map(Number)
  const code = major * 100000000 + minor * 1000000 + patch * 1000 + rc
  if (minor > 99 || patch > 999 || rc > 999 || code > 2100000000 || !Number.isSafeInteger(code)) {
    throw new Error('Opka beta version exceeds Android versionCode limits')
  }
  return code
}
