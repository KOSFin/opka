import { ipcMain } from 'electron'
import { isGitLabNetworkProfile } from '../../shared/gitlab-network-profile'
import { createGitLabNetworkProfileStore } from '../gitlab/gitlab-network-profile-store'

export function registerGitLabNetworkProfileHandlers(): void {
  const profiles = createGitLabNetworkProfileStore()
  const pending = new Map<string, { senderId: number; controller: AbortController }>()

  ipcMain.handle('gitlab:listNetworkProfiles', () => profiles.list())
  ipcMain.handle(
    'gitlab:provisionNetworkProfile',
    async (event, input: { intentId: string; host: string; user: string; token: string }) => {
      if (
        !input ||
        typeof input.intentId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(input.intentId) ||
        typeof input.host !== 'string' ||
        typeof input.user !== 'string' ||
        typeof input.token !== 'string' ||
        pending.has(input.intentId)
      ) {
        throw new Error('Invalid GitLab profile request.')
      }
      const controller = new AbortController()
      pending.set(input.intentId, { senderId: event.sender.id, controller })
      const cancel = () => controller.abort()
      event.sender.once('destroyed', cancel)
      try {
        return await profiles.provision({
          host: input.host,
          user: input.user,
          token: input.token,
          signal: controller.signal
        })
      } finally {
        event.sender.removeListener('destroyed', cancel)
        pending.delete(input.intentId)
      }
    }
  )
  ipcMain.handle('gitlab:cancelNetworkProfileProvision', (event, intentId: string) => {
    const request = pending.get(intentId)
    if (request?.senderId === event.sender.id) {
      request.controller.abort()
    }
  })
  ipcMain.handle('gitlab:removeNetworkProfile', (_event, value: unknown) => {
    if (!isGitLabNetworkProfile(value)) {
      throw new Error('Invalid GitLab profile binding.')
    }
    profiles.remove(value)
  })
}
