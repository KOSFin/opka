import { expect, test } from 'vitest'
import { writeNativeProbeResponse } from './codex-native-probe-response.mjs'
import { SYNTHETIC_COMPACTION_CIPHERTEXT } from './codex-native-probe-ciphertext.mjs'

test('native streamed compact returns one opaque compaction item without text or reasoning', () => {
  const events = []
  const response = {
    writeHead() {},
    write(chunk) {
      events.push(JSON.parse(chunk.split('data: ')[1]))
    },
    end() {}
  }
  writeNativeProbeResponse(response, { model: 'synthetic' }, 'synthetic-A', 1, false, true, true)
  expect(events.map((event) => event.type)).toEqual([
    'response.created',
    'response.output_item.done',
    'response.completed'
  ])
  expect(events.at(-1).response.output).toEqual([
    {
      id: 'cmp_1',
      type: 'compaction',
      encrypted_content: SYNTHETIC_COMPACTION_CIPHERTEXT
    }
  ])
})
