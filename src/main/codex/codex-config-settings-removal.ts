import { scanStructuredSettingLines } from './config-toml-promoted-setting-values'
import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

export function removePromotedSettingsFromContent(
  content: string,
  removals: ReadonlySet<string>
): string {
  if (removals.size === 0) {
    return content
  }
  const lines = content.split('\n')
  const indexes = scanStructuredSettingLines(lines)
    .filter((setting) => removals.has(setting.structuredKey))
    .map((setting) => setting.index)
  for (const index of indexes.toReversed()) {
    let end = index
    let state = createTomlLineScanState()
    do {
      state = updateTomlLineScanState(state, lines[end] ?? '')
      end += 1
    } while (end < lines.length && !isTomlStructuralLine(state))
    lines.splice(index, end - index)
  }
  return lines.join('\n')
}
