import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BoundGitCloneChoice } from '../../../../shared/git-network-binding'
import type { GitLabNetworkProfile } from '../../../../shared/gitlab-network-profile'
import type { GhAccountBindingInventory } from '../../../../shared/github/auth-types'
import { normalizeGitHttpsHost } from '../../../../shared/git-https-host'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { translate } from '@/i18n/i18n'
import { CloneGitLabProfileDialog } from './CloneGitLabProfileDialog'
import { CloneGitLabProfileRemovalDialog } from './CloneGitLabProfileRemovalDialog'
import { RemoteGlabProfileImport } from '../settings/RemoteGlabProfileImport'

type Mode = 'unbound' | 'github' | 'gitlab'

export function CloneNetworkAccountPicker({
  url,
  runtimeEnvironmentId,
  selected,
  onSelect,
  onModeChange,
  disabled
}: {
  url: string
  runtimeEnvironmentId?: string | null
  selected: BoundGitCloneChoice | null
  onSelect: (choice: BoundGitCloneChoice | null) => void
  onModeChange: (required: boolean) => void
  disabled: boolean
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('unbound')
  const [inventory, setInventory] = useState<GhAccountBindingInventory | null>(null)
  const [profiles, setProfiles] = useState<GitLabNetworkProfile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addOwnerKey, setAddOwnerKey] = useState<string | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removePending, setRemovePending] = useState(false)
  const [reload, setReload] = useState(0)
  const loadGeneration = useRef(0)
  let urlHost: string | null = null
  try {
    const parsed = new URL(url)
    urlHost = parsed.protocol === 'https:' ? normalizeGitHttpsHost(parsed.host) : null
  } catch {
    urlHost = null
  }
  const currentOwnerKey = `${runtimeEnvironmentId ?? 'local'}\0${urlHost ?? ''}`

  useEffect(() => {
    let active = true
    const generation = ++loadGeneration.current
    const isCurrent = (): boolean => active && generation === loadGeneration.current
    onSelect(null)
    setRemoveOpen(false)
    setRemovePending(false)
    setInventory(null)
    setProfiles([])
    setError(null)
    if (mode === 'unbound' || !urlHost) {
      setLoading(false)
      return
    }
    const timeout = setTimeout(() => {
      const target = runtimeTargetForOwnerEnvironment(runtimeEnvironmentId ?? null)
      setLoading(true)
      const load = async (): Promise<void> => {
        try {
          if (mode === 'github') {
            const result =
              target.kind === 'environment'
                ? await callRuntimeRpc<GhAccountBindingInventory>(
                    target,
                    'github.listCloneAccounts',
                    { url, refreshCapability: reload > 0 }
                  )
                : await window.api.gh.listCloneAccounts({ url, refreshCapability: reload > 0 })
            if (isCurrent()) {
              setInventory(result)
            }
          } else {
            const result =
              target.kind === 'environment'
                ? await callRuntimeRpc<GitLabNetworkProfile[]>(
                    target,
                    'gitlab.listNetworkProfiles',
                    {}
                  )
                : await (window.api.gl.listNetworkProfiles?.() ??
                    Promise.reject(new Error('Host update required.')))
            if (isCurrent()) {
              setProfiles(result.filter((entry) => entry.host === urlHost))
            }
          }
        } catch (failure) {
          if (isCurrent()) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
        } finally {
          if (isCurrent()) {
            setLoading(false)
          }
        }
      }
      void load()
    }, 250)
    return () => {
      active = false
      clearTimeout(timeout)
    }
  }, [mode, onSelect, reload, runtimeEnvironmentId, url, urlHost])

  const accounts =
    inventory?.capability === 'supported'
      ? inventory.accounts.filter((entry) => entry.source === 'keyring' && entry.host === urlHost)
      : []
  const selectedKey =
    selected?.provider === 'github'
      ? `github:${selected.host}\0${selected.user}`
      : selected?.provider === 'gitlab'
        ? `gitlab:${selected.profileId}`
        : undefined
  const selectedProfile =
    selected?.provider === 'gitlab'
      ? profiles.find((profile) => profile.id === selected.profileId)
      : undefined

  const removeSelectedProfile = async (): Promise<void> => {
    if (!selectedProfile || !window.api.gl.removeNetworkProfile) {
      return
    }
    const generation = loadGeneration.current
    setRemovePending(true)
    setError(null)
    try {
      await window.api.gl.removeNetworkProfile(selectedProfile)
      if (generation !== loadGeneration.current) {
        return
      }
      setProfiles((current) => current.filter((profile) => profile.id !== selectedProfile.id))
      onSelect(null)
      setRemoveOpen(false)
    } catch (failure) {
      if (generation === loadGeneration.current) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (generation === loadGeneration.current) {
        setRemovePending(false)
      }
    }
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>
          {translate('auto.components.sidebar.cloneNetwork.mode', 'Git network account')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.sidebar.cloneNetwork.description',
            'Choose a saved account on the execution host. Commit author is configured separately.'
          )}
        </p>
      </div>
      <Select
        value={mode}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === 'unbound' || value === 'github' || value === 'gitlab') {
            setMode(value)
            setAddOpen(false)
            onModeChange(value !== 'unbound')
            onSelect(null)
          }
        }}
      >
        <SelectTrigger aria-label="Git network account provider" className="min-h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unbound">Use existing Git configuration</SelectItem>
          <SelectItem value="github">GitHub account</SelectItem>
          <SelectItem value="gitlab">GitLab profile</SelectItem>
        </SelectContent>
      </Select>
      {mode !== 'unbound' && (
        <>
          <Select
            value={selectedKey}
            disabled={disabled || loading || !urlHost || Boolean(error)}
            onValueChange={(key) => {
              if (mode === 'github') {
                const account = accounts.find(
                  (entry) => `github:${entry.host}\0${entry.user}` === key
                )
                onSelect(
                  account ? { provider: 'github', host: account.host, user: account.user } : null
                )
              } else {
                const profile = profiles.find((entry) => `gitlab:${entry.id}` === key)
                onSelect(profile ? { provider: 'gitlab', profileId: profile.id } : null)
              }
            }}
          >
            <SelectTrigger aria-label="Verified Git network account" className="min-h-11">
              <SelectValue placeholder="Select a verified account" />
            </SelectTrigger>
            <SelectContent>
              {mode === 'github'
                ? accounts.map((account) => (
                    <SelectItem
                      key={`${account.host}\0${account.user}`}
                      value={`github:${account.host}\0${account.user}`}
                    >
                      {account.user} · {account.host}
                    </SelectItem>
                  ))
                : profiles.map((profile) => (
                    <SelectItem key={profile.id} value={`gitlab:${profile.id}`}>
                      {profile.user} · {profile.host}
                    </SelectItem>
                  ))}
            </SelectContent>
          </Select>
          {mode === 'gitlab' && !runtimeEnvironmentId && window.api.gl.provisionNetworkProfile && (
            <Button
              variant="outline"
              size="sm"
              className="max-sm:min-h-11"
              onClick={() => {
                setAddOwnerKey(currentOwnerKey)
                setAddOpen(true)
              }}
              disabled={disabled}
            >
              Add verified GitLab profile
            </Button>
          )}
          {selectedProfile && !runtimeEnvironmentId && window.api.gl.removeNetworkProfile && (
            <Button
              variant="outline"
              size="sm"
              className="max-sm:min-h-11"
              onClick={() => setRemoveOpen(true)}
              disabled={disabled}
            >
              Remove selected profile…
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="max-sm:min-h-11"
            onClick={() => setReload((current) => current + 1)}
            disabled={disabled || loading || !urlHost}
          >
            Refresh accounts
          </Button>
          <p className="text-xs text-muted-foreground" role="status">
            {!urlHost
              ? 'Enter a complete HTTPS clone URL to select an account.'
              : error
                ? `Account selection is unavailable on this host: ${error}`
                : loading
                  ? 'Checking accounts on the execution host…'
                  : mode === 'github' && inventory?.capability !== 'supported'
                    ? 'This host cannot confirm multiple GitHub accounts. Update or reconnect the host.'
                    : (mode === 'github' ? accounts.length : profiles.length) === 0
                      ? 'No verified account for this URL on the execution host.'
                      : 'A removed account blocks bound fetch and push until another is selected.'}
          </p>
          {mode === 'gitlab' && runtimeEnvironmentId && urlHost && (
            <RemoteGlabProfileImport
              key={currentOwnerKey}
              runtimeEnvironmentId={runtimeEnvironmentId}
              host={urlHost}
              disabled={disabled || loading}
              onImported={(profile) => {
                setProfiles((current) => [
                  ...current.filter((entry) => entry.id !== profile.id),
                  profile
                ])
                onSelect({ provider: 'gitlab', profileId: profile.id })
              }}
            />
          )}
        </>
      )}
      <CloneGitLabProfileDialog
        key={currentOwnerKey}
        open={addOpen && addOwnerKey === currentOwnerKey}
        onOpenChange={setAddOpen}
        host={urlHost}
        ownerKey={currentOwnerKey}
        onAdded={(profile) => {
          setProfiles((current) => [...current.filter((entry) => entry.id !== profile.id), profile])
          onSelect({ provider: 'gitlab', profileId: profile.id })
        }}
      />
      <CloneGitLabProfileRemovalDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        pending={removePending}
        onRemove={() => void removeSelectedProfile()}
      />
    </div>
  )
}
