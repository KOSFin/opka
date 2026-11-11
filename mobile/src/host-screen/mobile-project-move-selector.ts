import {
  getRepoExecutionHostId,
  isRepoOnCatalogHost,
  parseExecutionHostId
} from '../../../src/shared/execution-host'
import type { HostRepoCatalogRow } from './host-screen-reply-schema'

export function isMovableRepoOnProjectHost(
  repo: HostRepoCatalogRow,
  targetHostId: string,
  targetConnectionId: string | null | undefined
): boolean {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return (
    Boolean(repo.path) &&
    (!repo.executionHostId || parseExecutionHostId(repo.executionHostId) !== null) &&
    host?.id === targetHostId &&
    (repo.connectionId ?? null) === (targetConnectionId ?? null) &&
    (host.kind === 'local'
      ? isRepoOnCatalogHost(repo)
      : host.kind === 'ssh'
        ? repo.connectionId === host.targetId
        : host.kind === 'runtime')
  )
}
