import { useEffect, useRef, useState } from 'react'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host'
import type { ProjectGroup } from '../../../src/shared/project-group-types'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import { getProjectGroupExecutionHostIdForRows } from '../../../src/shared/sidebar-list/host-filtering'
import type { RpcClient } from '../transport/rpc-client'
import {
  projectGroupMoveProjectWrite,
  projectGroupUpdateWrite
} from '../worktree/project-group-write-operations'
import type { HostRepoCatalogRow } from './host-screen-reply-schema'
import { readManagedProjectGroups, readManagedProjectRepos } from './managed-project-catalog-reads'
import { isMovableRepoOnProjectHost } from './mobile-project-move-selector'

export type ManagedProjectGroup = {
  id: string
  hostId: string
  clientHostId: string
  title: string
}

const groupHost = (group: ProjectGroup) =>
  getProjectGroupExecutionHostIdForRows(group, LOCAL_EXECUTION_HOST_ID)

function actionError(failure: unknown, fallback: string): string {
  const message = failure instanceof Error ? failure.message : ''
  return /not available to mobile clients|method.not.found|unknown method/i.test(message)
    ? 'This host does not support project edits. Update the host before retrying.'
    : message || fallback
}

function requireGroup(groups: ProjectGroup[], target: ManagedProjectGroup): ProjectGroup {
  const matches = groups.filter((group) => group.id === target.id)
  const selected = matches[0]
  if (!selected || matches.length !== 1 || groupHost(selected) !== target.hostId) {
    throw new Error('Project changed or belongs to another host. Refresh the host list.')
  }
  return selected
}

export function useMobileProjectGroupManager(
  client: RpcClient | null,
  connection: string,
  target: ManagedProjectGroup,
  onSaved: () => void
) {
  const generation = client?.getGeneration?.() ?? 0
  const owner = useRef({ client, generation, target })
  owner.current = { client, generation, target }
  const alive = useRef(true)
  const inFlight = useRef(false)
  const [groups, setGroups] = useState<ProjectGroup[]>([])
  const [group, setGroup] = useState<ProjectGroup | null>(null)
  const [repos, setRepos] = useState<HostRepoCatalogRow[]>([])
  const [name, setName] = useState(target.title)
  const [icon, setIcon] = useState<RepoIcon | null | undefined>()
  const [iconChanged, setIconChanged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = () =>
    alive.current &&
    owner.current.client === client &&
    owner.current.generation === generation &&
    owner.current.target.id === target.id &&
    owner.current.target.hostId === target.hostId &&
    owner.current.target.clientHostId === target.clientHostId &&
    client !== null &&
    client.getState() === 'connected' &&
    (client.getGeneration?.() ?? 0) === generation &&
    connection === 'connected'

  useEffect(() => {
    alive.current = true
    if (!client || connection !== 'connected') {
      setError('Host disconnected. Refresh after reconnecting.')
      return
    }
    let active = true
    void readManagedProjectGroups(client)
      .then((fresh) => {
        if (!active || !current()) {
          return
        }
        const selected = requireGroup(fresh, target)
        setGroups(fresh)
        setGroup(selected)
        setName(selected.name)
        setIcon(selected.groupIcon)
        setIconChanged(false)
      })
      .catch((failure: unknown) => {
        if (active && current()) {
          setError(actionError(failure, 'Could not read projects. Refresh the host.'))
        }
      })
    return () => {
      active = false
      alive.current = false
    }
  }, [client, connection, generation, target.id, target.hostId, target.clientHostId])

  async function save(): Promise<void> {
    if (!client || !current() || !group || inFlight.current) {
      return
    }
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Enter a project name.')
      return
    }
    const updates = {
      ...(trimmed !== group.name ? { name: trimmed } : {}),
      ...(iconChanged ? { groupIcon: icon ?? null } : {})
    }
    if (Object.keys(updates).length === 0) {
      return
    }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      projectGroupUpdateWrite.interpret(
        await projectGroupUpdateWrite.request(client, { groupId: group.id, updates })
      )
      if (!current()) {
        return
      }
      const fresh = await readManagedProjectGroups(client)
      if (!current()) {
        return
      }
      const confirmed = requireGroup(fresh, target)
      if (
        confirmed.name !== trimmed ||
        (iconChanged &&
          (!('groupIcon' in confirmed) ||
            JSON.stringify(confirmed.groupIcon) !== JSON.stringify(icon ?? null)))
      ) {
        throw new Error(
          'The host did not confirm the project change. Update the host or refresh before retrying.'
        )
      }
      setGroups(fresh)
      setGroup(confirmed)
      setIconChanged(false)
      onSaved()
    } catch (failure) {
      if (current()) {
        setError(actionError(failure, 'Project change unverified. Refresh before retrying.'))
      }
    } finally {
      inFlight.current = false
      if (alive.current) {
        setBusy(false)
      }
    }
  }

  async function prepareMove(): Promise<boolean> {
    if (!client || !current() || inFlight.current) {
      return false
    }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const freshGroups = await readManagedProjectGroups(client)
      if (!current()) {
        return false
      }
      const freshRepos = await readManagedProjectRepos(client)
      if (!current()) {
        return false
      }
      const selectedGroup = requireGroup(freshGroups, target)
      const movable = freshRepos.filter(
        (repo) =>
          isMovableRepoOnProjectHost(repo, target.hostId, selectedGroup.connectionId) &&
          freshRepos.filter(
            (row) =>
              row.id === repo.id &&
              row.path === repo.path &&
              getRepoExecutionHostId(row) === getRepoExecutionHostId(repo)
          ).length === 1
      )
      if (movable.length === 0) {
        setError('No repositories have a verified host selector here. Refresh or update the host.')
        return false
      }
      setGroups(freshGroups)
      setRepos(movable)
      return true
    } catch (failure) {
      if (current()) {
        setError(actionError(failure, 'Could not read host projects. Refresh before retrying.'))
      }
      return false
    } finally {
      inFlight.current = false
      if (alive.current) {
        setBusy(false)
      }
    }
  }

  async function move(repo: HostRepoCatalogRow, destinationId: string | null): Promise<void> {
    if (
      !client ||
      !current() ||
      !group ||
      groupHost(group) !== target.hostId ||
      !isMovableRepoOnProjectHost(repo, target.hostId, group.connectionId) ||
      repos.filter(
        (row) =>
          row.id === repo.id &&
          row.path === repo.path &&
          row.connectionId === repo.connectionId &&
          getRepoExecutionHostId(row) === getRepoExecutionHostId(repo)
      ).length !== 1 ||
      inFlight.current
    ) {
      return
    }
    const sourceHost = getRepoExecutionHostId(repo)
    const destinations = groups.filter(
      (candidate) =>
        candidate.id === destinationId &&
        groupHost(candidate) === sourceHost &&
        (candidate.connectionId ?? null) === (repo.connectionId ?? null)
    )
    if (destinationId !== null && destinations.length !== 1) {
      setError('The destination project is on another host or changed. Refresh before moving.')
      return
    }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      projectGroupMoveProjectWrite.interpret(
        await projectGroupMoveProjectWrite.request(client, {
          repo: `path:${repo.path}`,
          groupId: destinationId,
          connectionId: repo.connectionId ?? null
        })
      )
      if (!current()) {
        return
      }
      const fresh = await readManagedProjectRepos(client)
      if (!current()) {
        return
      }
      const matches = fresh.filter(
        (row) =>
          row.id === repo.id && row.path === repo.path && getRepoExecutionHostId(row) === sourceHost
      )
      if (matches.length !== 1 || matches[0]?.projectGroupId !== destinationId) {
        throw new Error(
          'The host did not confirm the project move. Update the host or refresh before retrying.'
        )
      }
      setRepos(fresh)
      onSaved()
    } catch (failure) {
      if (current()) {
        setError(actionError(failure, 'Project move unverified. Refresh before retrying.'))
      }
    } finally {
      inFlight.current = false
      if (alive.current) {
        setBusy(false)
      }
    }
  }

  return {
    group,
    groups,
    repos,
    name,
    setName,
    icon,
    setIcon: (next: RepoIcon | null) => {
      setIcon(next)
      setIconChanged(true)
    },
    busy,
    error,
    save,
    prepareMove,
    move
  }
}
