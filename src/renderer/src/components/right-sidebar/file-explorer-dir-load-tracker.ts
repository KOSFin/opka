export type FileExplorerDirLoadToken = {
  dirPath: string
  revision: number
  session: number
  signal: AbortSignal
}

export type FileExplorerDirLoadSession = number

export type FileExplorerDirLoadTracker = {
  begin: (dirPath: string) => FileExplorerDirLoadToken
  isCurrent: (token: FileExplorerDirLoadToken) => boolean
  finish: (token: FileExplorerDirLoadToken) => void
  getSession: () => FileExplorerDirLoadSession
  isSessionCurrent: (session: FileExplorerDirLoadSession) => boolean
  reset: () => void
}

export function createFileExplorerDirLoadTracker(): FileExplorerDirLoadTracker {
  let session = 0
  const revisionsByDir = new Map<string, number>()
  const controllersByDir = new Map<string, AbortController>()

  return {
    begin: (dirPath) => {
      controllersByDir.get(dirPath)?.abort()
      const controller = new AbortController()
      controllersByDir.set(dirPath, controller)
      const revision = (revisionsByDir.get(dirPath) ?? 0) + 1
      revisionsByDir.set(dirPath, revision)
      return { dirPath, revision, session, signal: controller.signal }
    },
    isCurrent: (token) =>
      token.session === session && revisionsByDir.get(token.dirPath) === token.revision,
    finish: (token) => {
      if (token.session === session && revisionsByDir.get(token.dirPath) === token.revision) {
        controllersByDir.delete(token.dirPath)
      }
    },
    getSession: () => session,
    isSessionCurrent: (snapshot) => snapshot === session,
    reset: () => {
      for (const controller of controllersByDir.values()) {
        controller.abort()
      }
      controllersByDir.clear()
      session += 1
      revisionsByDir.clear()
    }
  }
}
