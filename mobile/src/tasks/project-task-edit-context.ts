import type { RpcClient } from '../transport/rpc-client'

type Context = {
  client: RpcClient | null
  worktree: string
  executionHostId: string
}
export function captureTaskEditContext(context: Context) {
  return { ...context, generation: context.client?.getGeneration?.() ?? 0 }
}
export function taskEditContextMatches(
  original: ReturnType<typeof captureTaskEditContext>,
  current: Context
): boolean {
  return (
    original.client === current.client &&
    original.worktree === current.worktree &&
    original.executionHostId === current.executionHostId &&
    original.generation === (current.client?.getGeneration?.() ?? 0)
  )
}
