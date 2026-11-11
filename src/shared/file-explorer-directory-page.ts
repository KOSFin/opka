import type { DirEntry } from './filesystem-entry-types'

export type FileExplorerDirectoryPage = {
  entries: DirEntry[]
  nextCursor: string | null
}

export type FileExplorerDirectoryPageOptions = {
  cursor?: string
  followSymlinks?: boolean
  limit?: number
  signal?: AbortSignal
}
