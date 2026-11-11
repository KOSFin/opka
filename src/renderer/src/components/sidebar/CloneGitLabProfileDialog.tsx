import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitLabNetworkProfile } from '../../../../shared/gitlab-network-profile'
import { normalizeGitHttpsHost } from '../../../../shared/git-https-host'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

export function CloneGitLabProfileDialog({
  open,
  onOpenChange,
  host,
  ownerKey,
  onAdded
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  host: string | null
  ownerKey: string
  onAdded: (profile: GitLabNetworkProfile) => void
}): React.JSX.Element {
  const [profileHost, setProfileHost] = useState(host ?? '')
  const [user, setUser] = useState('')
  const [token, setToken] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const intentRef = useRef<string | null>(null)
  const generationRef = useRef(0)

  const cancelPendingIntent = useCallback((): void => {
    ++generationRef.current
    if (intentRef.current) {
      void window.api.gl.cancelNetworkProfileProvision?.(intentRef.current)
      intentRef.current = null
    }
  }, [])

  const cancel = (): void => {
    cancelPendingIntent()
    setPending(false)
    setToken('')
  }

  useEffect(() => () => cancelPendingIntent(), [cancelPendingIntent, host, ownerKey])

  const setOpen = (next: boolean): void => {
    if (!next) {
      cancel()
      setError(null)
      setUser('')
    } else {
      setProfileHost(host ?? '')
    }
    onOpenChange(next)
  }

  const verify = async (): Promise<void> => {
    const canonicalHost = normalizeGitHttpsHost(profileHost)
    if (!canonicalHost || !user.trim() || !token) {
      setError('Enter a valid HTTPS host, username and token.')
      return
    }
    const provision = window.api.gl.provisionNetworkProfile
    if (!provision) {
      setError('This execution host cannot save GitLab profiles. Update or reconnect it.')
      return
    }
    const intentId = createUuidV4()
    const generation = ++generationRef.current
    intentRef.current = intentId
    const submittedToken = token
    setToken('')
    setPending(true)
    setError(null)
    try {
      const profile = await provision({
        intentId,
        host: canonicalHost,
        user: user.trim(),
        token: submittedToken
      })
      if (generation !== generationRef.current) {
        return
      }
      onAdded(profile)
      setOpen(false)
    } catch (failure) {
      if (generation !== generationRef.current) {
        return
      }
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (generation === generationRef.current) {
        intentRef.current = null
        setPending(false)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent surface="security" scrollable className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.sidebar.gitlabProfile.addTitle',
              'Add a named GitLab profile'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.sidebar.gitlabProfile.addDescription',
              'The token is verified and stored on this execution host. It is separate from the commit author.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="gitlab-network-host">GitLab HTTPS host</Label>
            <Input
              id="gitlab-network-host"
              autoFocus
              value={profileHost}
              onChange={(event) => setProfileHost(event.target.value)}
              disabled={pending}
              className="min-h-11"
              placeholder="gitlab.example.com"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gitlab-network-user">Username</Label>
            <Input
              id="gitlab-network-user"
              value={user}
              onChange={(event) => setUser(event.target.value)}
              disabled={pending}
              className="min-h-11"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gitlab-network-token">Personal access token</Label>
            <p className="text-xs text-muted-foreground">
              Use a token permitted to clone and push the selected repository.
            </p>
            <Input
              id="gitlab-network-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && !pending) {
                  event.preventDefault()
                  void verify()
                }
              }}
              disabled={pending}
              className="min-h-11"
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {pending && (
            <p role="status" className="text-xs text-muted-foreground">
              Verifying on this host…
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" className="min-h-11" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button className="min-h-11" disabled={pending || !token} onClick={() => void verify()}>
            {pending ? 'Verifying…' : 'Verify and save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
