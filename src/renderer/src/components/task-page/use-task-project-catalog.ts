import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { ProjectTaskCatalog } from '../../../../shared/project-task-catalog'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { projectTaskError, taskProjectKey, type TaskProjectScope } from './project-task-projects'
import { TaskSnapshotCache } from './project-task-snapshot-cache'

const catalogs = new TaskSnapshotCache<TaskProjectScope[]>(1024 * 1024, 4)

export function useTaskProjectCatalog() {
  const sourceRevision = useAppStore((state) =>
    JSON.stringify(
      state.runtimeEnvironments
        .map((entry) => {
          const contact = state.runtimeStatusByEnvironmentId.get(entry.id)
          return [
            entry.id,
            entry.name,
            entry.pairingRevision ?? entry.createdAt,
            entry.preferredEndpointId,
            contact?.status?.runtimeId,
            contact?.connectionGeneration,
            contact?.hostContactEpoch
          ]
        })
        .sort()
    )
  )
  const rootRevision = useAppStore((state) =>
    JSON.stringify([
      state.folderWorkspaces
        .map((folder) => [folder.id, folder.folderPath, folder.isArchived, folder.executionHostId])
        .sort(),
      state.repos.map((repo) => [repo.id, repo.path, repo.executionHostId]).sort()
    ])
  )
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const [projects, setProjects] = useState<TaskProjectScope[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const key = JSON.stringify([sourceRevision, rootRevision])
  const [loadedKey, setLoadedKey] = useState('')
  useEffect(() => {
    let cancelled = false
    const sources = [
      { label: 'This computer', target: { kind: 'local' } as const },
      ...useAppStore.getState().runtimeEnvironments.map((entry) => ({
        label: entry.name,
        target: { kind: 'environment', environmentId: entry.id } as const
      }))
    ]
    setLoading(true)
    const next: TaskProjectScope[] = [],
      failures: string[] = []
    const settled = new Set<string>()
    const publish = () => {
      if (cancelled) {
        return
      }
      const sorted = [...next].sort(
        (a, b) => a.name.localeCompare(b.name) || a.hostLabel.localeCompare(b.hostLabel)
      )
      const retained = catalogs.peek(key) ?? []
      const scopes = [
        ...sorted,
        ...retained.filter(
          (old) =>
            !sorted.some((entry) => entry.key === old.key) &&
            (!settled.has(JSON.stringify(old.target)) ||
              failures.some((failure) => failure.startsWith(`${old.hostLabel}:`)))
        )
      ]
      setProjects(scopes)
      setLoadedKey(key)
      setErrors([...failures])
      return scopes
    }
    const load = async (target: RuntimeClientTarget, label: string) => {
      try {
        const catalog = await callRuntimeRpc<ProjectTaskCatalog>(
          target,
          'projectTask.catalog',
          undefined,
          { timeoutMs: 12000 }
        )
        if (catalog.truncated) {
          failures.push(`${label}: project limit reached. Not all projects are shown.`)
        }
        next.push(
          ...catalog.projects.map((project) => ({
            ...project,
            target,
            hostLabel: label,
            key: taskProjectKey(target, project.root)
          }))
        )
      } catch (error) {
        failures.push(`${label}: ${projectTaskError(error)}`)
      }
      settled.add(JSON.stringify(target))
      publish()
    }
    void (async () => {
      for (let i = 0; i < sources.length; i += 2) {
        if (cancelled) {
          return
        }
        await Promise.all(
          sources.slice(i, i + 2).map((source) => load(source.target, source.label))
        )
      }
      if (!cancelled) {
        const scopes = publish()
        if (scopes) {
          await catalogs.load(key, async () => scopes)
        }
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sourceRevision, rootRevision, revision, key])
  return {
    projects: loadedKey === key ? projects : (catalogs.peek(key) ?? []),
    errors,
    loading,
    refresh,
    revision
  }
}
