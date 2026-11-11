import { createHash } from 'node:crypto'
import { parseBoundGitCredentialTarget } from './bound-git-credential-target'

export type BoundGitRemoteSnapshot = {
  remoteUrl: string
  configFingerprint: string
}

export type ReadBoundGitLocalCommand = (args: readonly string[]) => Promise<Buffer>

const UNSAFE_CONFIG_KEY =
  /^(?:credential(?:\.|$)|http(?:\.|$)|url(?:\.|$)|protocol(?:\.|$)|core\.(?:askpass|gitproxy|sshcommand)$|remote\..+\.(?:pushurl|proxy|uploadpack|receivepack)$)/

function inspectLocalConfig(bytes: Buffer): void {
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Bound Git configuration unavailable.')
  }
  if (!content.endsWith('\0')) {
    throw new Error('Bound Git configuration unavailable.')
  }
  for (const entry of content.slice(0, -1).split('\0')) {
    const separator = entry.indexOf('\n')
    if (separator < 1 || UNSAFE_CONFIG_KEY.test(entry.slice(0, separator).toLowerCase())) {
      throw new Error('Bound Git configuration unavailable.')
    }
  }
}

function oneRemoteUrl(bytes: Buffer, username: string): string {
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Bound Git remote unavailable.')
  }
  const urls = content.endsWith('\n') ? content.slice(0, -1).split('\n') : []
  if (urls.length !== 1) {
    throw new Error('Bound Git remote unavailable.')
  }
  return parseBoundGitCredentialTarget(urls[0], username).url
}

export async function readBoundGitEffectiveRemote(
  operation: 'fetch' | 'pull' | 'push',
  remoteName: string,
  username: string,
  readGit: ReadBoundGitLocalCommand
): Promise<BoundGitRemoteSnapshot> {
  if (!remoteName || /[\r\n\0]/.test(remoteName) || remoteName.startsWith('-')) {
    throw new Error('Bound Git remote unavailable.')
  }
  const config = await readGit(['config', '--includes', '--null', '--list'])
  inspectLocalConfig(config)
  const remote = await readGit([
    'remote',
    'get-url',
    '--all',
    ...(operation === 'push' ? ['--push'] : []),
    '--',
    remoteName
  ])
  const remoteUrl = oneRemoteUrl(remote, username)
  const configFingerprint = createHash('sha256')
    .update(config)
    .update('\0')
    .update(operation)
    .update('\0')
    .update(remoteName)
    .update('\0')
    .update(remoteUrl)
    .digest('hex')
  return { remoteUrl, configFingerprint }
}
