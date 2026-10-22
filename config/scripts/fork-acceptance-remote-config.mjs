import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export function readRemoteAcceptanceConfig(
  env = process.env,
  filename = resolve('.tmp/fork-acceptance/remote-config.json')
) {
  const local = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : {}
  const settings = {
    host: env.ORCA_FORK_AUDIT_SSH_HOST ?? local.host,
    username: env.ORCA_FORK_AUDIT_SSH_USER ?? local.username,
    identityFile: env.ORCA_FORK_AUDIT_IDENTITY_FILE ?? local.identityFile,
    remoteRoot: env.ORCA_FORK_AUDIT_REMOTE_ROOT ?? local.remoteRoot
  }
  if (
    typeof settings.host !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(settings.host) ||
    typeof settings.username !== 'string' ||
    !/^[a-z_][a-z0-9_-]*$/i.test(settings.username) ||
    typeof settings.identityFile !== 'string' ||
    !isAbsolute(settings.identityFile) ||
    typeof settings.remoteRoot !== 'string' ||
    !/^\/[a-zA-Z0-9_./-]+$/.test(settings.remoteRoot) ||
    settings.remoteRoot === '/' ||
    settings.remoteRoot.split('/').includes('..')
  ) {
    throw new Error(
      'Explicit isolated audit host, user, absolute identity path and safe remote fixture root required. Use ORCA_FORK_AUDIT_* or ignored .tmp/fork-acceptance/remote-config.json.'
    )
  }
  return settings
}
