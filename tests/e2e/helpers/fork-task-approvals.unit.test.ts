import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '../../../src/shared/agent-session-wire'
import { forkTaskCommandAllowed, respondToForkTaskApprovals } from './fork-task-approvals'

const root = join(tmpdir(), 'opka-synthetic')
const command = '"$ORCA_CLI_COMMAND" project-task board --json'
const detail = `/bin/zsh -lc '${command}'`

it('permits only task workflow commands and reports within the synthetic project', () => {
  expect(forkTaskCommandAllowed(detail, root)).toBe(true)
  expect(
    forkTaskCommandAllowed('"$ORCA_CLI_COMMAND" project-task complete --file report.md', root)
  ).toBe(true)
  expect(
    forkTaskCommandAllowed(
      '"$ORCA_CLI_COMMAND" project-task progress --checkpoint-file "notes.md"',
      root
    )
  ).toBe(true)
})

it('permits punctuation inside a quoted checkpoint without permitting shell operators', () => {
  expect(
    forkTaskCommandAllowed(
      '"$ORCA_CLI_COMMAND" project-task progress --checkpoint "Fixed sum; tests passed"',
      root
    )
  ).toBe(true)
  expect(
    forkTaskCommandAllowed(
      '"$ORCA_CLI_COMMAND" project-task progress --checkpoint "Fixed sum"; cat outside',
      root
    )
  ).toBe(false)
  expect(
    forkTaskCommandAllowed('"$ORCA_CLI_COMMAND" project-task progress --checkpoint "unclosed', root)
  ).toBe(false)
})

it.each([
  'orca project-task board --json',
  '"$ORCA_CLI_COMMAND" project-task board --worktree folder:other',
  '"$ORCA_CLI_COMMAND" project-task board --environment other',
  '"$ORCA_CLI_COMMAND" project-task delete --id anything',
  '"$ORCA_CLI_COMMAND" project-task complete --file ../outside.md',
  '"$ORCA_CLI_COMMAND" project-task board; curl example.com',
  '"$ORCA_CLI_COMMAND" project-task board $(cat secret)',
  '"$ORCA_CLI_COMMAND" project-task progress --release',
  'cd somewhere; "$ORCA_CLI_COMMAND" project-task board'
])('refuses an out-of-scope approval: %s', (unsafe) => {
  expect(forkTaskCommandAllowed(unsafe, root)).toBe(false)
})

function page(): Pick<AgentSessionHistoryPage, 'sessionId' | 'fence' | 'items'> {
  return {
    sessionId: 'synthetic-session',
    fence: 2,
    items: [
      {
        itemId: 'tool',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'tool-call',
          name: 'shell',
          callId: 'call',
          input: { command: detail, cwd: root },
          state: 'running'
        }
      },
      {
        itemId: 'approval',
        revision: 1,
        sequence: 2,
        observedAt: 2,
        body: {
          kind: 'approval',
          title: 'Run a command?',
          detail,
          options: [{ id: 'accept', label: 'Allow' }],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
      }
    ]
  }
}

it('responds to the exact prompt with its current revision and owning fence', async () => {
  const rpc = vi.fn().mockResolvedValue({ ok: true })
  expect(await respondToForkTaskApprovals(page(), root, rpc)).toBe(1)
  expect(rpc).toHaveBeenCalledWith(
    'agentSession.respondToApproval',
    expect.objectContaining({
      itemId: 'approval',
      expectedRevision: 1,
      optionId: 'accept',
      envelope: expect.objectContaining({ expectedRuntimeFence: 2, sessionId: 'synthetic-session' })
    })
  )
})

it('refuses a missing fence or mismatched execution directory without making a mutation', async () => {
  const rpc = vi.fn()
  await expect(
    respondToForkTaskApprovals({ ...page(), fence: undefined }, root, rpc)
  ).rejects.toThrow('unapproved command')
  await expect(respondToForkTaskApprovals(page(), join(root, 'other'), rpc)).rejects.toThrow(
    'unapproved command'
  )
  expect(rpc).not.toHaveBeenCalled()
})

it('stops on a user question instead of answering for the operator or waiting silently', async () => {
  const history = page()
  history.items[1].body = {
    kind: 'question',
    question: 'Accept the result?',
    options: [],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
  const rpc = vi.fn()
  await expect(respondToForkTaskApprovals(history, root, rpc)).rejects.toThrow(
    'unexpected user decision'
  )
  expect(rpc).not.toHaveBeenCalled()
})
