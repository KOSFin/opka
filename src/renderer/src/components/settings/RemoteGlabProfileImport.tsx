import { useEffect, useRef, useState } from 'react'
import type { GitLabNetworkProfile } from '../../../../shared/gitlab-network-profile'
import {
  GITLAB_NATIVE_PROFILE_IMPORT_RUNTIME_CAPABILITY,
  isGitLabNetworkProfile
} from '../../../../shared/gitlab-network-profile'
import { normalizeGitHttpsHost } from '../../../../shared/git-https-host'
import { callRuntimeRpc, getRuntimeEnvironmentStatus } from '@/runtime/runtime-rpc-client'
import { Button } from '../ui/button'

export function RemoteGlabProfileImport({
  runtimeEnvironmentId,
  host,
  disabled,
  onImported
}: {
  runtimeEnvironmentId: string
  host: string
  disabled: boolean
  onImported: (profile: GitLabNetworkProfile) => void
}): React.JSX.Element {
  const [supported, setSupported] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setSupported(null)
    setPending(false)
    setError(null)
    void getRuntimeEnvironmentStatus(runtimeEnvironmentId)
      .then((status) => {
        if (current === generation.current) {
          setSupported(
            status.capabilities?.includes(GITLAB_NATIVE_PROFILE_IMPORT_RUNTIME_CAPABILITY) ?? false
          )
        }
      })
      .catch(() => {
        if (current === generation.current) {
          setSupported(false)
        }
      })
    return () => {
      generation.current = current + 1
    }
  }, [runtimeEnvironmentId, host])

  const importProfile = async (): Promise<void> => {
    const normalizedHost = normalizeGitHttpsHost(host)
    if (!normalizedHost || normalizedHost !== host || pending) {
      setError('Enter the GitLab HTTPS host for this repository.')
      return
    }
    const current = generation.current
    setPending(true)
    setError(null)
    try {
      const status = await getRuntimeEnvironmentStatus(runtimeEnvironmentId)
      if (current !== generation.current) {
        return
      }
      if (!status.capabilities?.includes(GITLAB_NATIVE_PROFILE_IMPORT_RUNTIME_CAPABILITY)) {
        throw new Error('Update or reconnect this execution host to import its glab login.')
      }
      const profile = await callRuntimeRpc<GitLabNetworkProfile>(
        { kind: 'environment', environmentId: runtimeEnvironmentId },
        'gitlab.importNativeNetworkProfile',
        { host: normalizedHost },
        { expectedEnvironmentRuntimeId: status.runtimeId }
      )
      if (!isGitLabNetworkProfile(profile) || profile.host !== normalizedHost) {
        throw new Error(
          'This host did not return the selected GitLab profile. Reconnect and retry.'
        )
      }
      if (current === generation.current) {
        onImported(profile)
      }
    } catch (cause) {
      if (current === generation.current) {
        setError(
          cause instanceof Error ? cause.message : 'Could not import this host’s glab login.'
        )
      }
    } finally {
      if (current === generation.current) {
        setPending(false)
      }
    }
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || pending || supported !== true || !host}
        onClick={() => void importProfile()}
      >
        {pending ? 'Importing…' : 'Use this host’s glab login'}
      </Button>
      {supported === false && (
        <p role="status" className="text-xs text-muted-foreground">
          Update or reconnect this execution host to import its glab login.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
