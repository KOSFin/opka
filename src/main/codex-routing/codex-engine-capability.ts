/** Windows has no durable engine writer-group proof yet; its ordinary native launches remain available. */
export function supportsCodexEngineGateway(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}
