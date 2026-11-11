// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitLabNetworkProfile } from '../../../../shared/gitlab-network-profile'
import { CloneGitLabProfileDialog } from './CloneGitLabProfileDialog'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const profile: GitLabNetworkProfile = {
  id: 'a'.repeat(64),
  host: 'gitlab.example',
  user: 'alice',
  generation: 'fixture-generation'
}

afterEach(() => cleanup())

describe('GitLab profile provision intent ownership', () => {
  it('cancels held verification on unmount and ignores its late result', async () => {
    const pending = deferred<GitLabNetworkProfile>()
    const provision = vi.fn((_input: { intentId: string }) => pending.promise)
    const cancel = vi.fn(async () => undefined)
    const onAdded = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gl: { provisionNetworkProfile: provision, cancelNetworkProfileProvision: cancel } }
    })
    const user = userEvent.setup()
    const view = render(
      <CloneGitLabProfileDialog
        open
        onOpenChange={vi.fn()}
        host={profile.host}
        ownerKey="local"
        onAdded={onAdded}
      />
    )
    await user.type(screen.getByLabelText('Username'), 'alice')
    await user.type(screen.getByLabelText('Personal access token'), 'fixture-token')
    await user.click(screen.getByRole('button', { name: 'Verify and save' }))
    expect(provision).toHaveBeenCalledOnce()
    const intentId = provision.mock.calls[0][0].intentId
    view.unmount()
    expect(cancel).toHaveBeenCalledWith(intentId)
    await act(async () => {
      pending.resolve(profile)
      await pending.promise
    })
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('cancels held verification when execution owner changes with the same URL host', async () => {
    const pending = deferred<GitLabNetworkProfile>()
    const provision = vi.fn((_input: { intentId: string }) => pending.promise)
    const cancel = vi.fn(async () => undefined)
    const onAdded = vi.fn()
    const onOpenChange = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gl: { provisionNetworkProfile: provision, cancelNetworkProfileProvision: cancel } }
    })
    const user = userEvent.setup()
    const view = render(
      <CloneGitLabProfileDialog
        open
        onOpenChange={onOpenChange}
        host={profile.host}
        ownerKey="local"
        onAdded={onAdded}
      />
    )
    await user.type(screen.getByLabelText('Username'), 'alice')
    await user.type(screen.getByLabelText('Personal access token'), 'fixture-token')
    await user.click(screen.getByRole('button', { name: 'Verify and save' }))
    const intentId = provision.mock.calls[0][0].intentId
    view.rerender(
      <CloneGitLabProfileDialog
        open
        onOpenChange={onOpenChange}
        host={profile.host}
        ownerKey="remote-2"
        onAdded={onAdded}
      />
    )
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(intentId))
    await act(async () => {
      pending.resolve(profile)
      await pending.promise
    })
    expect(onAdded).not.toHaveBeenCalled()
  })
})
