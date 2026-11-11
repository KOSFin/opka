import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type { BoundGitCloneChoice } from '../../../../shared/git-network-binding'
import type { GitLabNetworkProfile } from '../../../../shared/gitlab-network-profile'
import type { GhAccountBindingInventory } from '../../../../shared/github/auth-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { listRepositoryGhBindableAccounts } from './repository-github-account'
import {
  bindRepositoryGitNetworkAccount,
  matchesRepositoryGitNetworkChoice
} from './repository-git-network-binding'
import { CloneGitLabProfileDialog } from '../sidebar/CloneGitLabProfileDialog'

const UNBOUND = '__git_network_unbound__'

function bindingKey(repo: Repo): string {
  const binding = repo.gitNetworkBinding
  return binding?.provider === 'gitlab'
    ? `gitlab:${binding.id}`
    : binding?.provider === 'github'
      ? `github:${binding.host}\0${binding.user}`
      : UNBOUND
}

export function RepositoryGitNetworkSection({
  repo,
  forceVisible
}: {
  repo: Repo
  forceVisible?: boolean
}): React.JSX.Element {
  const ownerId = getRepoExecutionHostId(repo)
  const owner = parseExecutionHostId(ownerId)
  const runtimeEnvironmentId = owner?.kind === 'runtime' ? owner.environmentId : null
  const target = useMemo(
    () => runtimeTargetForOwnerEnvironment(runtimeEnvironmentId),
    [runtimeEnvironmentId]
  )
  const inventoryRepo = useMemo(() => ({ id: repo.id, path: repo.path }), [repo.id, repo.path])
  const [profiles, setProfiles] = useState<GitLabNetworkProfile[]>([])
  const [inventory, setInventory] = useState<GhAccountBindingInventory | null>(null)
  const [profilesUnverifiable, setProfilesUnverifiable] = useState(false)
  const [accountsUnverifiable, setAccountsUnverifiable] = useState(false)
  const [binding, setBinding] = useState(repo.gitNetworkBinding)
  const [choiceKey, setChoiceKey] = useState(bindingKey(repo))
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setLoading(true)
    setError(null)
    setProfiles([])
    setInventory(null)
    setProfilesUnverifiable(false)
    setAccountsUnverifiable(false)
    if (owner?.kind !== 'local' && owner?.kind !== 'runtime') {
      setLoading(false)
      return
    }
    const load = async (): Promise<void> => {
      try {
        const profileRequest =
          target.kind === 'environment'
            ? callRuntimeRpc<GitLabNetworkProfile[]>(target, 'gitlab.listNetworkProfiles', {})
            : (window.api.gl.listNetworkProfiles?.() ??
              Promise.reject(new Error('Host update required.')))
        const results = await Promise.allSettled([
          profileRequest,
          listRepositoryGhBindableAccounts(target, inventoryRepo)
        ])
        if (current !== generation.current) {
          return
        }
        if (results[0].status === 'fulfilled') {
          setProfiles(results[0].value)
        } else {
          setProfilesUnverifiable(true)
        }
        if (results[1].status === 'fulfilled') {
          setInventory(results[1].value)
        } else {
          setAccountsUnverifiable(true)
        }
        if (results.every((result) => result.status === 'rejected')) {
          setError('This host cannot list Git network accounts. Update or reconnect it.')
        }
      } finally {
        if (current === generation.current) {
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      generation.current = current + 1
    }
  }, [inventoryRepo, ownerId, owner?.kind, runtimeEnvironmentId, target])

  const accounts =
    inventory?.capability === 'supported'
      ? inventory.accounts.filter((account) => account.source === 'keyring')
      : []
  const selectedProfile =
    binding?.provider === 'gitlab'
      ? profiles.find(
          (profile) => profile.id === binding.id && profile.generation === binding.generation
        )
      : undefined
  const selectedAccount =
    binding?.provider === 'github'
      ? accounts.find((account) => account.host === binding.host && account.user === binding.user)
      : undefined
  const unverifiable =
    binding?.provider === 'gitlab'
      ? profilesUnverifiable
      : accountsUnverifiable || inventory?.capability !== 'supported'
  const unavailable = Boolean(
    binding && !selectedProfile && !selectedAccount && !loading && !unverifiable
  )

  const apply = async (): Promise<void> => {
    if (saving || loading) {
      return
    }
    const current = generation.current
    const profile = profiles.find((entry) => `gitlab:${entry.id}` === choiceKey)
    const account = accounts.find((entry) => `github:${entry.host}\0${entry.user}` === choiceKey)
    const choice: BoundGitCloneChoice | null = profile
      ? { provider: 'gitlab', profileId: profile.id }
      : account
        ? { provider: 'github', host: account.host, user: account.user }
        : null
    if (choiceKey !== UNBOUND && !choice) {
      setError('Selected account is unavailable. Choose another verified account.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const updated = await bindRepositoryGitNetworkAccount(repo, choice)
      if (!matchesRepositoryGitNetworkChoice(updated, choice)) {
        throw new Error(
          'This host did not save the selected Git network account. Update or reconnect it.'
        )
      }
      if (current !== generation.current) {
        return
      }
      setBinding(updated.gitNetworkBinding)
    } catch (failure) {
      if (current === generation.current) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (current === generation.current) {
        setSaving(false)
      }
    }
  }

  return (
    <SearchableSetting
      title="Git network account"
      description="Choose the account for this repository’s clone, fetch, pull and push. Commit author stays separate."
      keywords={['git network', 'gitlab profile', 'github account', repo.displayName]}
      className="space-y-3"
      forceVisible={forceVisible}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Git network account</h3>
        <p className="text-xs text-muted-foreground">
          Choose the account for this repository’s clone, fetch, pull and push. Commit author stays
          separate.
        </p>
      </div>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {binding
            ? `${binding.provider === 'gitlab' ? 'GitLab' : 'GitHub'} · ${binding.user} · ${binding.host}`
            : 'Using existing Git configuration for this repository.'}
        </p>
        <Select
          value={choiceKey}
          onValueChange={setChoiceKey}
          disabled={loading || saving || owner?.kind === 'ssh'}
        >
          <SelectTrigger aria-label="Git network account" className="min-h-11">
            <SelectValue placeholder="Select an account" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNBOUND}>Use existing Git configuration</SelectItem>
            {profiles.map((profile) => (
              <SelectItem key={profile.id} value={`gitlab:${profile.id}`}>
                GitLab · {profile.user} · {profile.host}
              </SelectItem>
            ))}
            {accounts.map((account) => (
              <SelectItem
                key={`${account.host}\0${account.user}`}
                value={`github:${account.host}\0${account.user}`}
              >
                GitHub · {account.user} · {account.host}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={loading || saving || owner?.kind === 'ssh'}
            onClick={() => void apply()}
          >
            {saving ? 'Saving…' : 'Use selected account'}
          </Button>
          {owner?.kind === 'local' && window.api.gl.provisionNetworkProfile && (
            <Button variant="outline" onClick={() => setAddOpen(true)} disabled={saving}>
              Add GitLab profile
            </Button>
          )}
        </div>
        {unavailable && (
          <p role="status" className="text-xs text-destructive">
            This saved account is unavailable on the execution host. Select another verified
            account; bound Git operations stay blocked.
          </p>
        )}
        {binding && unverifiable && !loading && (
          <p role="status" className="text-xs text-muted-foreground">
            This execution host cannot verify the saved account now. Reconnect or refresh before
            changing it.
          </p>
        )}
        {owner?.kind === 'ssh' && (
          <p role="status" className="text-xs text-muted-foreground">
            Select an account in Orca on the execution host that owns this SSH repository.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <CloneGitLabProfileDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        host={binding?.provider === 'gitlab' ? binding.host : null}
        ownerKey={`${getRepoExecutionHostId(repo)}\0${repo.id}\0${repo.path}`}
        onAdded={(profile) => {
          setProfiles((current) => [...current.filter((entry) => entry.id !== profile.id), profile])
          setChoiceKey(`gitlab:${profile.id}`)
        }}
      />
    </SearchableSetting>
  )
}
