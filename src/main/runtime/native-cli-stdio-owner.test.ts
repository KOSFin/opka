import { expect, it } from 'vitest'
import { stageNativeCliStdioOwner, waitNativeCliStdioOwner } from './native-cli-stdio-owner'

it('stages 100 native stdio owners, rejects a duplicate, and retires every capability', async () => {
  const runtime = {}
  const ids = Array.from({ length: 100 }, (_, index) => `synthetic-owner-${index}`)
  const owners = ids.map((id) => stageNativeCliStdioOwner(runtime, id))
  expect(() => stageNativeCliStdioOwner(runtime, ids[0])).toThrow()
  owners.forEach((owner) => owner.retire())
  for (const id of ids) {
    expect(await waitNativeCliStdioOwner(runtime, id)).toBeNull()
  }
  const replacement = stageNativeCliStdioOwner(runtime, ids[0])
  replacement.retire()
  expect(await waitNativeCliStdioOwner(runtime, ids[0])).toBeNull()
})
