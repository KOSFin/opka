import { useEffect, useState } from 'react'
import { cachedProjectTaskBoard, readProjectTaskBoard } from './project-task-client'
import {
  projectTaskError,
  type TaskProjectScope,
  type TaskProjectView
} from './project-task-projects'

export function useTaskProjectOverview(
  projects: TaskProjectScope[],
  selected: string,
  revision: number,
  limit: number
) {
  const [loaded, setLoaded] = useState<{
    key: string
    views: TaskProjectView[]
    errors: string[]
  } | null>(null)
  const key = JSON.stringify([projects, selected, limit])
  const [loading, setLoading] = useState(false)
  const cached = projects
    .filter(
      (project) => project.state === 'configured' && (selected === '*' || project.key === selected)
    )
    .slice(0, limit)
    .flatMap((scope) => {
      const board = cachedProjectTaskBoard(scope.target, scope.selector)
      return board ? [{ scope, board }] : []
    })
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      const views = new Map<string, TaskProjectView>()
      const errors: string[] = []
      const chosen = projects.filter(
        (project) =>
          project.state === 'configured' && (selected === '*' || project.key === selected)
      )
      const batchProjects = chosen.slice(0, limit)
      for (const scope of batchProjects) {
        const board = cachedProjectTaskBoard(scope.target, scope.selector)
        if (board) {
          views.set(scope.key, { scope, board })
        }
      }
      const read = async (scope: TaskProjectScope) => {
        if (cancelled) {
          return
        }
        try {
          views.set(scope.key, {
            scope,
            board: await readProjectTaskBoard(scope.target, scope.selector)
          })
        } catch (error) {
          errors.push(`${scope.name} · ${scope.hostLabel}: ${projectTaskError(error)}`)
          const board = cachedProjectTaskBoard(scope.target, scope.selector)
          if (board) {
            views.set(scope.key, { scope, board })
          }
        }
        if (!cancelled) {
          setLoaded({ key, views: [...views.values()], errors: [...errors] })
        }
      }
      for (let offset = 0; offset < batchProjects.length; offset += 2) {
        if (cancelled) {
          return
        }
        await Promise.all(batchProjects.slice(offset, offset + 2).map(read))
      }
      if (!cancelled) {
        setLoaded({ key, views: [...views.values()], errors })
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projects, selected, revision, limit, key])
  return {
    views: loaded?.key === key ? loaded.views : cached,
    errors: loaded?.key === key ? loaded.errors : [],
    loading
  }
}
