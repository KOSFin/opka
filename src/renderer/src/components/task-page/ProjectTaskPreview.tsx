import { createContext, useContext, useMemo, useState, type ComponentProps } from 'react'
import type { Components } from 'react-markdown'
import { MarkdownPreviewBody } from '@/components/editor/MarkdownPreviewBody'
import { resolveMarkdownLinkTarget } from '@/components/editor/markdown-internal-links'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { openHttpLink } from '@/lib/http-link-routing'
import type { ProjectTaskClient } from './project-task-client'

const PreviewOwner = createContext<{
  client: ProjectTaskClient
  path: string
  setError: (message: string) => void
} | null>(null)
function ProjectTaskLink({ href, children }: ComponentProps<'a'>) {
  const owner = useContext(PreviewOwner)
  return (
    <a
      href={href}
      onClick={(event) => {
        if (href?.startsWith('#')) {
          return
        }
        event.preventDefault()
        if (!owner) {
          return
        }
        const { client, path, setError } = owner
        setError('')
        const target = resolveMarkdownLinkTarget(
          href,
          `/__orca_project__/${path}`,
          '/__orca_project__'
        )
        if (target?.kind === 'external' && /^https?:\/\//i.test(target.url)) {
          openHttpLink(target.url, {
            worktreeId: client.worktree,
            sourceOwner:
              client.target.kind === 'local'
                ? { kind: 'local' }
                : { kind: 'runtime', runtimeEnvironmentId: client.target.environmentId }
          })
        } else if (
          (target?.kind === 'markdown' || target?.kind === 'file') &&
          target.relativePath
        ) {
          void callRuntimeRpc(client.target, 'files.open', {
            worktree: client.worktree,
            relativePath: target.relativePath
          }).catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : String(cause))
          )
        } else {
          setError(
            'This link is outside the project or uses an unsupported protocol. No local fallback was opened.'
          )
        }
      }}
    >
      {children}
    </a>
  )
}
function ProjectTaskImage() {
  return null
}
const COMPONENTS: Components = { a: ProjectTaskLink, img: ProjectTaskImage }

export function ProjectTaskPreview({
  client,
  path,
  body
}: {
  client: ProjectTaskClient
  path: string
  body: string
}) {
  const [error, setError] = useState('')
  const owner = useMemo(() => ({ client, path, setError }), [client, path])
  return (
    <div className="markdown-body text-sm">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <PreviewOwner.Provider value={owner}>
        <MarkdownPreviewBody content={body} components={COMPONENTS} />
      </PreviewOwner.Provider>
    </div>
  )
}
