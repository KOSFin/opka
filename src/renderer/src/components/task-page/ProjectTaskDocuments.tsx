import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ProjectTaskPreview } from './ProjectTaskPreview'
import { projectTaskCall, type ProjectTaskClient } from './project-task-client'

function documentLabel(path: string): string {
  const name = path.split('/').at(-1) ?? path
  if (name === 'notes.md') {
    return 'Notes'
  }
  if (name === 'checkpoint.md') {
    return 'Checkpoint'
  }
  return `Report · ${name.replace(/\.md$/, '')}`
}

export function ProjectTaskDocuments({
  client,
  id,
  active,
  version,
  preferredPath
}: {
  client: ProjectTaskClient
  id: string
  active: boolean
  version: string
  preferredPath?: string | null
}) {
  const [paths, setPaths] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [document, setDocument] = useState<{ path: string; content: string } | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!active) {
      return
    }
    let cancelled = false
    void projectTaskCall<{ paths: string[] }>(client, 'documents', { id })
      .then((result) => {
        if (cancelled) {
          return
        }
        setPaths(result.paths)
        setSelected((prior) =>
          result.paths.includes(prior)
            ? prior
            : preferredPath && result.paths.includes(preferredPath)
              ? preferredPath
              : (result.paths.find((path) => path.includes('/reports/')) ?? result.paths[0] ?? '')
        )
        setLoaded(true)
        setError('')
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, id, active, version, reload, preferredPath])
  useEffect(() => {
    if (!active || !selected) {
      return
    }
    let cancelled = false
    void projectTaskCall<{ path: string; content: string }>(client, 'documents', {
      id,
      path: selected
    })
      .then((result) => {
        if (!cancelled) {
          setDocument(result)
          setError('')
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, id, selected, active, version, reload])
  return (
    <section hidden={!active} className="space-y-3" aria-label="Task reports and notes">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}{' '}
          <Button variant="link" onClick={() => setReload((value) => value + 1)}>
            Retry reading documents
          </Button>
        </p>
      )}
      {!loaded && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Reading task documents…
        </p>
      )}
      {loaded && paths.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No saved reports or notes yet. The agent’s checkpoint and result will appear here when
          saved.
        </p>
      )}
      {paths.length > 0 && (
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger aria-label="Saved task document">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {paths.map((path) => (
              <SelectItem key={path} value={path}>
                {documentLabel(path)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {selected && <p className="break-all text-xs text-muted-foreground">{selected}</p>}
      {selected && document?.path !== selected && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Reading selected document…
        </p>
      )}
      {document?.path === selected && (
        <ProjectTaskPreview client={client} path={document.path} body={document.content} />
      )}
    </section>
  )
}
