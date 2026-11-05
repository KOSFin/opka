/** Current-account child requests retain their genuine native lineage; they do not create a turn boundary. */
export function ownsNativeClaudeGatewaySession(
  request: { sessionId: string; parentSessionId?: string },
  options: {
    currentSessionId?: string
    canonicalSessionId?: string
    isKnownChild: (id: string) => boolean
  }
): boolean {
  if (request.sessionId === options.currentSessionId) {
    return true
  }
  if (!options.isKnownChild(request.sessionId)) {
    return false
  }
  return (
    !request.parentSessionId ||
    request.parentSessionId === options.currentSessionId ||
    request.parentSessionId === options.canonicalSessionId ||
    options.isKnownChild(request.parentSessionId)
  )
}
