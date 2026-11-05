import type { NativeClaudeCoverageObservation } from '../../shared/native-claude-coverage'

type Prompt = Extract<NativeClaudeCoverageObservation, { kind: 'prompt' }>
/** Native provenance, rather than user text, distinguishes private wakes from a new request. */
export function createNativeClaudePromptAdmission(options: {
  phase: {
    classifyWake: (marker: string) => 'current' | 'stale' | 'none'
    isPublishingWake: () => boolean
    observeInput: () => void
  }
  onNewInput: () => void
}) {
  let ownedWakeSubmission: string | undefined
  let pendingMarkers = 0
  let version = 0
  const manualMarkers = new Map<string, number>()
  return {
    version: () => version,
    observeLegacyInput: () => {
      version++
      options.onNewInput()
    },
    ownedWakeSubmission: () => (options.phase.isPublishingWake() ? ownedWakeSubmission : undefined),
    observePrompt: (event: Prompt, knownTask: boolean): { drop?: true } => {
      if (event.origin === 'task-notification' && knownTask) {
        return {}
      }
      const human = !event.meta && ['composer', 'sdk', 'bridge'].includes(event.origin)
      const wake = event.wakeMarker ? options.phase.classifyWake(event.wakeMarker) : 'none'
      if (!human && wake === 'stale') {
        return { drop: true }
      }
      if (!human && wake === 'current') {
        ownedWakeSubmission = event.submissionId
        return {}
      }
      ownedWakeSubmission = undefined
      version++
      options.onNewInput()
      options.phase.observeInput()
      if (human && event.wakeMarker && wake !== 'none') {
        if (pendingMarkers >= 128) {
          throw new Error('Native manual input admission is busy.')
        }
        pendingMarkers++
        manualMarkers.set(event.wakeMarker, (manualMarkers.get(event.wakeMarker) ?? 0) + 1)
      }
      return {}
    },
    consumeMarker: (marker: string | undefined): string | undefined => {
      const count = marker ? (manualMarkers.get(marker) ?? 0) : 0
      if (!marker || !count) {
        return marker
      }
      if (count === 1) {
        manualMarkers.delete(marker)
      } else {
        manualMarkers.set(marker, count - 1)
      }
      pendingMarkers--
      return undefined
    }
  }
}
