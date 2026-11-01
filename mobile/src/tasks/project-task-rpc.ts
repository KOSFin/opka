import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'

export const PROJECT_TASK_PRESENTATION_READ_OPTIONS = {
  timeoutMs: 30_000,
  budgetSpansConnect: true,
  failWhenDisconnected: true
} as const

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  revision: z.string(),
  path: z.string(),
  workflow: z.object({
    phase: z.string(),
    archived: z.boolean(),
    revisionChanged: z.boolean(),
    attempts: z.array(
      z.object({
        id: z.string(),
        nativeStatus: z.string(),
        terminal: z.string().nullable(),
        session: z
          .object({
            address: z.string().nullable().optional(),
            blocker: z.string().nullable(),
            reportPath: z.string().nullable()
          })
          .nullable()
          .optional()
      })
    ),
    events: z.array(
      z.object({
        sequence: z.number(),
        kind: z.string(),
        detail: z.string(),
        createdAt: z.string()
      })
    )
  })
})
export type MobileProjectTask = z.infer<typeof taskSchema>
export const catalogRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.catalog',
    method: 'projectTask.catalog',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'catalog',
      z.object({
        projects: z.array(
          z.object({
            selector: z.string(),
            name: z.string(),
            state: z.string(),
            message: z.string().optional()
          })
        ),
        truncated: z.boolean()
      })
    )
  })
)
export const boardRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.board',
    method: 'projectTask.board',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'board',
      z.object({
        project: z.object({
          id: z.string(),
          sources: z.array(z.object({ id: z.string(), path: z.string() })).optional()
        }),
        executionHostId: z.string(),
        total: z.number().int().min(0).max(1000),
        tasks: z.array(taskSchema)
      })
    )
  })
)
export const taskRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.show',
    method: 'projectTask.show',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'task',
      z.object({
        id: z.string(),
        revision: z.string(),
        body: z.string(),
        content: z.string().optional()
      })
    )
  })
)
export const documentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'project-tasks.documents',
    method: 'projectTask.documents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'documents',
      z.object({
        paths: z.array(z.string()),
        path: z.string().optional(),
        content: z.string().optional()
      })
    )
  })
)
export async function loadProjectTaskBoard(
  client: RpcClient,
  worktree: string,
  options?: SendRequestOptions
) {
  const generation = client.getGeneration?.() ?? 0
  const deadline = options?.timeoutMs === undefined ? null : Date.now() + options.timeoutMs
  const assertOwner = () => {
    if ((client.getGeneration?.() ?? 0) !== generation) {
      throw new Error('Project owner changed while loading. Refresh the board.')
    }
    if (options?.failWhenDisconnected && client.getState() !== 'connected') {
      throw new Error('Project host disconnected while loading. Refresh after reconnecting.')
    }
  }
  const readPage = async (offset: number) => {
    assertOwner()
    const params = { worktree, offset, limit: 100 }
    const remaining = deadline === null ? null : deadline - Date.now()
    if (remaining !== null && remaining <= 0) {
      throw new Error('Project board read timed out. Refresh to try again.')
    }
    const reply = options
      ? await boardRead.request(client, params, {
          ...options,
          ...(remaining === null ? {} : { timeoutMs: remaining })
        })
      : await boardRead.request(client, params)
    assertOwner()
    return boardRead.interpret(reply)
  }
  const first = await readPage(0)
  const tasks = [...first.tasks]
  for (let offset = 100; offset < first.total; offset += 100) {
    const page = await readPage(offset)
    if (
      page.executionHostId !== first.executionHostId ||
      page.project.id !== first.project.id ||
      page.total !== first.total
    ) {
      throw new Error('Project changed while loading. Refresh to read the current board.')
    }
    tasks.push(...page.tasks)
  }
  return { ...first, tasks }
}
