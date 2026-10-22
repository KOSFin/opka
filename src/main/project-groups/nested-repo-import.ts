import type {
  NestedRepoScanResult,
  ProjectGroup,
  ProjectGroupImportMode
} from '../../shared/project-group-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import {
  getRuntimePathBasename,
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../shared/cross-platform-path'

type CreateGroupInput = {
  name: string
  parentPath?: string | null
  connectionId?: string | null
  parentGroupId?: string | null
  createdFrom: ProjectGroup['createdFrom']
}

type NestedProjectGroupResolver = {
  getGroupForRepo: (repoPath: string) => ProjectGroup | undefined
  getRootGroup: () => ProjectGroup | undefined
  getCreatedGroups: () => ProjectGroup[]
}

export type ResolvedNestedRepoSelection = {
  selectedPaths: string[]
  rejectedPaths: string[]
}

type FolderScope = {
  relativePath: string
  name: string
  folderPath: string
  parentRelativePath: string | null
}

function canonicalizeImportPath(path: string): string | null {
  if (!isRuntimePathAbsolute(path)) {
    return null
  }
  return resolveRuntimePath(path, path)
}

function trimPathSeparators(path: string): string {
  if (path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)) {
    return path.replace(/\\/g, '/')
  }
  if (/^\/\/[^/]+\/[^/]+\/?$/.test(path.replace(/\\/g, '/'))) {
    return path.replace(/\\/g, '/').replace(/\/$/, '')
  }
  return path.replace(/\\/g, '/').replace(/\/+$/g, '')
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function getFolderRelativePathForRepo(parentPath: string, repoPath: string): string | null {
  const relativePath = relativePathInsideRoot(parentPath, repoPath)
  if (relativePath === null || relativePath === '') {
    return null
  }
  const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean)
  segments.pop()
  return segments.join('/')
}

function resolveFolderPath(parentPath: string, relativePath: string): string {
  return trimPathSeparators(resolveRuntimePath(parentPath, relativePath))
}

function getNearestScopePath(
  relativePath: string,
  scopePaths: { has: (value: string) => boolean }
): string | null {
  const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean)
  for (let length = segments.length; length > 0; length -= 1) {
    const candidate = segments.slice(0, length).join('/')
    if (scopePaths.has(candidate)) {
      return candidate
    }
  }
  return null
}

function buildFolderScopes(args: {
  parentPath: string
  repoPaths: readonly string[]
}): FolderScope[] {
  const folderPaths = new Set<string>()

  for (const repoPath of args.repoPaths) {
    const folderRelativePath = getFolderRelativePathForRepo(args.parentPath, repoPath)
    if (folderRelativePath === null) {
      continue
    }
    const segments = folderRelativePath.split('/').filter(Boolean)
    for (let length = 1; length <= segments.length; length += 1) {
      folderPaths.add(segments.slice(0, length).join('/'))
    }
  }

  const orderedPaths = [...folderPaths].sort(
    (left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right)
  )
  return orderedPaths.map((relativePath) => {
    const parentRelativePath = relativePath.split('/').slice(0, -1).join('/') || null
    return {
      relativePath,
      name: relativePath.split('/').at(-1)!,
      folderPath: resolveFolderPath(args.parentPath, relativePath),
      parentRelativePath
    }
  })
}

export function createNestedProjectGroupResolver(args: {
  parentPath: string
  groupName: string
  mode: ProjectGroupImportMode
  connectionId?: string | null
  repoPaths?: readonly string[]
  existingGroups?: readonly ProjectGroup[]
  folderWorkspaces?: readonly Pick<
    FolderWorkspace,
    'projectGroupId' | 'folderPath' | 'connectionId'
  >[]
  createGroup: (input: CreateGroupInput) => ProjectGroup
}): NestedProjectGroupResolver {
  const createdGroups: ProjectGroup[] = []
  // Every folder-scope read sits behind ensureRootGroup, so outside group mode the scopes are
  // unreachable. One flag drives both so the skip can never drift from the guard that justifies it.
  const createsGroups = args.mode === 'group'
  const folderScopes = createsGroups
    ? buildFolderScopes({ parentPath: args.parentPath, repoPaths: args.repoPaths ?? [] })
    : []
  const folderScopesByRelativePath = new Map(
    folderScopes.map((scope) => [scope.relativePath, scope])
  )
  const folderScopeGroups = new Map<string, ProjectGroup>()
  let rootGroup: ProjectGroup | undefined

  const groupKey = (
    input: Pick<ProjectGroup, 'parentPath' | 'connectionId' | 'parentGroupId'>
  ): string =>
    JSON.stringify([
      input.connectionId ?? null,
      input.parentGroupId ?? null,
      normalizeRuntimePathForComparison(input.parentPath ?? '')
    ])
  const existingGroups = new Map(
    (args.existingGroups ?? [])
      .filter((group) => group.createdFrom === 'folder-scan' && group.parentPath)
      .map((group) => [groupKey(group), group])
  )
  const getOrCreateGroup = (input: CreateGroupInput): ProjectGroup => {
    const existing = existingGroups.get(
      groupKey({
        parentPath: input.parentPath ?? null,
        connectionId: input.connectionId,
        parentGroupId: input.parentGroupId ?? null
      })
    )
    if (existing) {
      return existing
    }
    const group = args.createGroup(input)
    createdGroups.push(group)
    return group
  }

  const ensureRootGroup = (): ProjectGroup | undefined => {
    if (!createsGroups) {
      return undefined
    }
    if (rootGroup) {
      return rootGroup
    }
    const registered = (args.existingGroups ?? []).filter(
      (group) =>
        group.parentPath &&
        groupKey(group) ===
          groupKey({
            parentPath: args.parentPath,
            connectionId: args.connectionId,
            parentGroupId: null
          }) &&
        args.folderWorkspaces?.some(
          (folder) =>
            folder.projectGroupId === group.id &&
            normalizeRuntimePathForComparison(folder.folderPath) ===
              normalizeRuntimePathForComparison(args.parentPath) &&
            (folder.connectionId ?? null) === (args.connectionId ?? null)
        )
    )
    if (registered.length === 1) {
      rootGroup = registered[0]
      return rootGroup
    }
    const fallbackName = getRuntimePathBasename(trimPathSeparators(args.parentPath))
    rootGroup = getOrCreateGroup({
      name: args.groupName.trim() || fallbackName,
      parentPath: trimPathSeparators(args.parentPath),
      connectionId: args.connectionId ?? null,
      parentGroupId: null,
      createdFrom: 'folder-scan'
    })
    return rootGroup
  }

  const ensureFolderScopeGroup = (relativePath: string): ProjectGroup | undefined => {
    const root = ensureRootGroup()
    if (!root) {
      return undefined
    }
    const existing = folderScopeGroups.get(relativePath)
    if (existing) {
      return existing
    }
    const scope = folderScopesByRelativePath.get(relativePath)
    if (!scope) {
      return root
    }
    const parentGroup = scope.parentRelativePath
      ? ensureFolderScopeGroup(scope.parentRelativePath)
      : root
    const group = getOrCreateGroup({
      name: scope.name,
      parentPath: scope.folderPath,
      connectionId: args.connectionId ?? null,
      parentGroupId: parentGroup?.id ?? root.id,
      createdFrom: 'folder-scan'
    })
    folderScopeGroups.set(relativePath, group)
    return group
  }

  return {
    getGroupForRepo: (repoPath) => {
      const root = ensureRootGroup()
      if (!root) {
        return undefined
      }
      const folderRelativePath = getFolderRelativePathForRepo(args.parentPath, repoPath)
      const scopePath = folderRelativePath
        ? getNearestScopePath(folderRelativePath, folderScopesByRelativePath)
        : null
      return scopePath ? ensureFolderScopeGroup(scopePath) : root
    },
    getRootGroup: () => rootGroup,
    getCreatedGroups: () => [...createdGroups]
  }
}

export function resolveNestedRepoSelection(args: {
  scan: NestedRepoScanResult
  projectPaths: readonly string[]
}): ResolvedNestedRepoSelection {
  const candidatesByPath = new Map(
    args.scan.repos.map((repo) => [normalizeRuntimePathForComparison(repo.path), repo.path])
  )
  const selectedPaths: string[] = []
  const rejectedPaths: string[] = []
  const seen = new Set<string>()

  for (const repoPath of args.projectPaths) {
    const normalizedPath = normalizeRuntimePathForComparison(repoPath)
    if (seen.has(normalizedPath)) {
      continue
    }
    seen.add(normalizedPath)
    const canonicalPath = candidatesByPath.get(normalizedPath)
    if (canonicalPath) {
      selectedPaths.push(canonicalPath)
    } else {
      // Why: imports are derived from a bounded scan of this parent folder;
      // callers must not smuggle unrelated paths into the group hierarchy.
      rejectedPaths.push(repoPath)
    }
  }

  return { selectedPaths, rejectedPaths }
}

export function resolveNestedRepoImportPaths(args: {
  parentPath: string
  projectPaths: readonly string[]
}): ResolvedNestedRepoSelection {
  const selectedPaths: string[] = []
  const rejectedPaths: string[] = []
  const seen = new Set<string>()
  const canonicalParentPath = canonicalizeImportPath(args.parentPath)

  if (!canonicalParentPath) {
    return { selectedPaths, rejectedPaths: [...args.projectPaths] }
  }
  const normalizedParentPath = normalizeRuntimePathForComparison(canonicalParentPath)

  for (const repoPath of args.projectPaths) {
    const canonicalRepoPath = canonicalizeImportPath(repoPath)
    const normalizedPath = canonicalRepoPath
      ? normalizeRuntimePathForComparison(canonicalRepoPath)
      : normalizeRuntimePathForComparison(repoPath)
    if (seen.has(normalizedPath)) {
      continue
    }
    seen.add(normalizedPath)
    if (
      !canonicalRepoPath ||
      normalizedPath === normalizedParentPath ||
      !isPathInsideOrEqual(canonicalParentPath, canonicalRepoPath)
    ) {
      // Why: stopped scans import a caller-provided partial selection, so the
      // parent boundary still blocks dot-segment escapes without rescanning.
      rejectedPaths.push(repoPath)
      continue
    }
    selectedPaths.push(canonicalRepoPath)
  }

  return { selectedPaths, rejectedPaths }
}
