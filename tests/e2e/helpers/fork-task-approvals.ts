import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  AgentSessionHistoryPage,
  AgentSessionMutationResult
} from '../../../src/shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../src/shared/structured-agent-session-mutation'

type SmokeRpc = <T>(method: string, params: Record<string, unknown>) => Promise<T>

function unsafeShellSyntax(args: string): boolean {
  let quote: string | null = null
  for (const character of args) {
    if (/[\r\n`$\\]/.test(character)) {
      return true
    }
    if (quote) {
      if (character === quote) {
        quote = null
      }
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/[;&|<>]/.test(character)) {
      return true
    }
  }
  return quote !== null
}

export function forkTaskCommandAllowed(detail: string, root: string): boolean {
  const shell = detail.match(/^\/bin\/(?:zsh|bash|sh) -lc '([\s\S]*)'$/)
  const command = shell?.[1] ?? detail
  const prefix = '"$ORCA_CLI_COMMAND" project-task '
  if (!command.startsWith(prefix)) {
    return false
  }
  const args = command.slice(prefix.length)
  if (
    !/^(?:board|resume|claim|progress|complete|documents)(?:\s|$)/.test(args) ||
    unsafeShellSyntax(args) ||
    /--(?:worktree|environment|pairing-code|remote|accept|release)\b/.test(args)
  ) {
    return false
  }
  const files = args.matchAll(/--(?:file|checkpoint-file)(?:=|\s+)("[^"]*"|'[^']*'|\S+)/g)
  for (const match of files) {
    const file = match[1].replace(/^(['"])(.*)\1$/, '$2')
    const suffix = relative(resolve(root), resolve(root, file))
    if (!file || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      return false
    }
  }
  return true
}

export async function respondToForkTaskApprovals(
  page: Pick<AgentSessionHistoryPage, 'sessionId' | 'fence' | 'items'>,
  root: string,
  rpc: SmokeRpc
): Promise<number> {
  let approved = 0
  for (const item of page.items) {
    const body = item.body
    if (body.kind === 'question' && body.resolution.state === 'pending') {
      throw new Error('The synthetic agent requested an unexpected user decision')
    }
    if (body.kind !== 'approval' || body.resolution.state !== 'pending') {
      continue
    }
    const detail = body.detail
    const matchingTool = page.items.some(({ body: tool }) => {
      if (
        tool.kind !== 'tool-call' ||
        tool.name !== 'shell' ||
        !tool.input ||
        typeof tool.input !== 'object'
      ) {
        return false
      }
      return (
        'command' in tool.input &&
        tool.input.command === detail &&
        'cwd' in tool.input &&
        typeof tool.input.cwd === 'string' &&
        resolve(tool.input.cwd) === resolve(root)
      )
    })
    if (!page.fence || !detail || !matchingTool || !forkTaskCommandAllowed(detail, root)) {
      throw new Error(
        'The synthetic agent requested an unapproved command; no blanket permission granted'
      )
    }
    const fields = { itemId: item.itemId, expectedRevision: item.revision, optionId: 'accept' }
    const result = await rpc<AgentSessionMutationResult<unknown>>(
      'agentSession.respondToApproval',
      {
        ...fields,
        envelope: {
          sessionId: page.sessionId,
          expectedRuntimeFence: page.fence,
          clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
          payloadFingerprint: structuredAgentSessionPayloadFingerprint({
            method: 'agentSession.respondTo:approval',
            sessionId: page.sessionId,
            fields
          })
        }
      }
    )
    if (!result.ok) {
      throw new Error('The owning runtime refused the synthetic command approval')
    }
    approved += 1
  }
  return approved
}
