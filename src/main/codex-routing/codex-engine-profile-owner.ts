const profiles = new Set<string>()

export function claimCodexEngineProfile(profile: string): () => void {
  if (profiles.has(profile)) {
    throw new Error('This routing profile already has an execution-host owner.')
  }
  profiles.add(profile)
  return () => {
    profiles.delete(profile)
  }
}
