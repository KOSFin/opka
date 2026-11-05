import { expect, it, vi } from 'vitest'
import { createNativeClaudePromptAdmission } from './native-claude-prompt-admission'
const marker = `<opka-native-wake:v1:11111111-1111-4111-8111-111111111111:1:${'a'.repeat(64)}>`
function fixture() {
  const onNewInput = vi.fn(),
    observeInput = vi.fn()
  let publishing = false,
    kind: 'current' | 'stale' | 'none' = 'current'
  const admission = createNativeClaudePromptAdmission({
    onNewInput,
    phase: { classifyWake: () => kind, observeInput, isPublishingWake: () => publishing }
  })
  return {
    admission,
    onNewInput,
    observeInput,
    publishing: (value: boolean) => {
      publishing = value
    },
    wake: (value: typeof kind) => {
      kind = value
    }
  }
}
it('preserves real input even when it copies an authentic internal marker', () => {
  const f = fixture()
  expect(
    f.admission.observePrompt({ kind: 'prompt', origin: 'composer', wakeMarker: marker }, false)
  ).toEqual({})
  expect(f.onNewInput).toHaveBeenCalledOnce()
  expect(f.observeInput).toHaveBeenCalledOnce()
  expect(f.admission.consumeMarker(marker)).toBeUndefined()
  expect(f.admission.consumeMarker(marker)).toBe(marker)
})
it('drops only a proven stale internal wake and never cancels newer user work', () => {
  const f = fixture()
  f.wake('stale')
  expect(
    f.admission.observePrompt(
      { kind: 'prompt', origin: 'unclassified', meta: true, wakeMarker: marker },
      false
    )
  ).toEqual({ drop: true })
  expect(f.onNewInput).not.toHaveBeenCalled()
})
it('does not treat user-authored task-shaped content as a native completion', () => {
  const f = fixture()
  f.admission.observePrompt(
    {
      kind: 'prompt',
      origin: 'task-notification',
      taskId: 'known-native-id',
      taskStatus: 'completed'
    },
    true
  )
  expect(f.onNewInput).not.toHaveBeenCalled()
  f.admission.observePrompt(
    { kind: 'prompt', origin: 'composer', taskId: 'known-native-id', taskStatus: 'completed' },
    true
  )
  expect(f.onNewInput).toHaveBeenCalledOnce()
})
it('allows only the held native submission during the authenticated publication step', () => {
  const f = fixture()
  f.admission.observePrompt(
    {
      kind: 'prompt',
      origin: 'unclassified',
      meta: true,
      submissionId: 'native-wake-id',
      wakeMarker: marker
    },
    false
  )
  expect(f.admission.ownedWakeSubmission()).toBeUndefined()
  f.publishing(true)
  expect(f.admission.ownedWakeSubmission()).toBe('native-wake-id')
  f.admission.observePrompt({ kind: 'prompt', origin: 'composer' }, false)
  expect(f.admission.ownedWakeSubmission()).toBeUndefined()
})

it('never treats a genuine known task notification as a copied private wake', () => {
  const f = fixture()
  f.wake('stale')
  expect(
    f.admission.observePrompt(
      {
        kind: 'prompt',
        origin: 'task-notification',
        taskId: 'known-task',
        taskStatus: 'completed',
        wakeMarker: marker
      },
      true
    )
  ).toEqual({})
  expect(f.onNewInput).not.toHaveBeenCalled()
})
