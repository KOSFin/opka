import { useEffect, useRef, useState } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type { RepoGitAuthor, RepoGitAuthorUpdate } from '../../../../shared/repo-git-author'
import { REPO_GIT_AUTHOR_RUNTIME_CAPABILITY } from '../../../../shared/repo-git-author'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { callRuntimeRpc, getRuntimeEnvironmentStatus } from '@/runtime/runtime-rpc-client'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'

type AuthorOwner = { repo: Repo; runtimeId: string | null }

async function readAuthor(
  repo: Repo,
  pinnedRuntimeId?: string | null
): Promise<{
  author: RepoGitAuthor
  runtimeId: string | null
}> {
  const hostId = getRepoExecutionHostId(repo)
  const owner = parseExecutionHostId(hostId)
  if (owner?.kind === 'local') {
    return {
      author: await window.api.repos.getGitAuthor({
        repoId: repo.id,
        hostId,
        expectedPath: repo.path
      }),
      runtimeId: null
    }
  }
  if (owner?.kind !== 'runtime') {
    throw new Error('Git author settings require a connected execution host.')
  }
  const status = await getRuntimeEnvironmentStatus(owner.environmentId)
  if (
    !status.capabilities?.includes(REPO_GIT_AUTHOR_RUNTIME_CAPABILITY) ||
    (pinnedRuntimeId && status.runtimeId !== pinnedRuntimeId)
  ) {
    throw new Error(
      'This execution host cannot edit Git author settings. Refresh after reconnecting.'
    )
  }
  const result = await callRuntimeRpc<{ author: RepoGitAuthor }>(
    { kind: 'environment', environmentId: owner.environmentId },
    'repo.gitAuthor.get',
    { repo: repo.id, repoHostId: LOCAL_EXECUTION_HOST_ID, expectedPath: repo.path },
    { expectedEnvironmentRuntimeId: status.runtimeId }
  )
  return { author: result.author, runtimeId: status.runtimeId }
}

async function writeAuthor(
  owner: AuthorOwner,
  update: RepoGitAuthorUpdate
): Promise<RepoGitAuthor> {
  const { repo, runtimeId } = owner
  const hostId = getRepoExecutionHostId(repo)
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'local') {
    return window.api.repos.updateGitAuthor({
      repoId: repo.id,
      hostId,
      expectedPath: repo.path,
      ...update
    })
  }
  if (parsed?.kind !== 'runtime' || !runtimeId) {
    throw new Error('Git author execution host changed. Refresh before saving.')
  }
  const result = await callRuntimeRpc<{ author: RepoGitAuthor }>(
    { kind: 'environment', environmentId: parsed.environmentId },
    'repo.gitAuthor.update',
    { repo: repo.id, repoHostId: LOCAL_EXECUTION_HOST_ID, expectedPath: repo.path, ...update },
    { expectedEnvironmentRuntimeId: runtimeId }
  )
  return result.author
}

export function RepositoryGitAuthorSection({
  repo,
  forceVisible
}: {
  repo: Repo
  forceVisible?: boolean
}): React.JSX.Element | null {
  const [author, setAuthor] = useState<RepoGitAuthor | null>(null)
  const [owner, setOwner] = useState<AuthorOwner | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setAuthor(null)
    setOwner(null)
    setError(null)
    setBusy(true)
    void readAuthor(repo)
      .then((result) => {
        if (generation.current !== current) {
          return
        }
        setAuthor(result.author)
        setOwner({ repo, runtimeId: result.runtimeId })
        setName(result.author.name.local ?? '')
        setEmail(result.author.email.local ?? '')
      })
      .catch((cause: unknown) => {
        if (generation.current === current) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (generation.current === current) {
          setBusy(false)
        }
      })
    return () => {
      generation.current = current + 1
    }
  }, [repo, reload])

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!author || !owner || busy) {
      return
    }
    const current = generation.current
    setBusy(true)
    setError(null)
    try {
      await writeAuthor(owner, {
        name: name.trim() || null,
        email: email.trim() || null,
        expectedLocalName: author.name.local,
        expectedLocalEmail: author.email.local
      })
      const result = await readAuthor(repo, owner.runtimeId)
      if (generation.current !== current) {
        return
      }
      setAuthor(result.author)
      setOwner({ repo, runtimeId: result.runtimeId })
      setName(result.author.name.local ?? '')
      setEmail(result.author.email.local ?? '')
    } catch (cause) {
      if (generation.current === current) {
        setError(cause instanceof Error ? cause.message : String(cause))
        setAuthor(null)
        setOwner(null)
      }
    } finally {
      if (generation.current === current) {
        setBusy(false)
      }
    }
  }

  return (
    <SearchableSetting
      title="Commit author"
      description="Name and email written into this repository's Git config. Authentication stays separate."
      keywords={[repo.displayName, 'git', 'commit', 'author', 'name', 'email']}
      forceVisible={forceVisible}
    >
      <form className="space-y-3" onSubmit={(event) => void save(event)}>
        <div>
          <Label htmlFor={`author-name-${repo.id}`}>Author name</Label>
          <Input
            id={`author-name-${repo.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!author || busy}
          />
          <p className="text-xs text-muted-foreground">
            Effective: {author?.name.effective ?? 'Unset'} ({author?.name.origin ?? 'unavailable'})
          </p>
        </div>
        <div>
          <Label htmlFor={`author-email-${repo.id}`}>Author email</Label>
          <Input
            id={`author-email-${repo.id}`}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={!author || busy}
          />
          <p className="text-xs text-muted-foreground">
            Effective: {author?.email.effective ?? 'Unset'} ({author?.email.origin ?? 'unavailable'}
            )
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Leave a field blank to inherit its global Git setting.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={!author || busy}>
            Save author
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setReload((value) => value + 1)}
          >
            Refresh author
          </Button>
        </div>
      </form>
    </SearchableSetting>
  )
}
