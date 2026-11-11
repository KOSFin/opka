import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'
import { createRepoUpdateSchema } from './repo-update-params'
import { RepoSelector, RepoShow } from './github-repo-target-params'
import { sanitizeRepoIcon } from '../repo-icon'

export const RepoPath = z.object({
  path: requiredString('Missing repo path'),
  kind: z.enum(['git', 'folder']).optional(),
  displayName: OptionalString
})

export const RepoCreate = z.object({
  parentPath: requiredString('Missing parent path'),
  name: requiredString('Missing repo name'),
  kind: z.enum(['git', 'folder']).optional()
})

export const RepoClone = z.object({
  url: requiredString('Missing clone URL'),
  destination: requiredString('Missing clone destination')
})

// A separate method makes an older host reject profile selection before it starts an unbound clone.
export const RepoCloneBoundGitLab = RepoClone.extend({
  profileId: requiredString('Missing GitLab profile')
})

export const RepoCloneBoundGitHub = RepoClone.extend({
  account: z.object({
    host: requiredString('Missing GitHub host'),
    user: requiredString('Missing GitHub user')
  })
})

export const RepoGitLabProfileBind = RepoShow.extend({
  expectedPath: requiredString('Missing expected repository path'),
  profileId: z.string().nullable(),
  remoteName: z.string().optional()
})

export const RepoGitHubNetworkBind = RepoShow.extend({
  expectedPath: requiredString('Missing expected repository path'),
  account: z.object({ host: z.string(), user: z.string() }).nullable(),
  remoteName: z.string().optional()
})

export const RepoGitAuthorGet = RepoShow.extend({
  expectedPath: requiredString('Missing expected repository path')
})

export const RepoGitAuthorUpdate = RepoGitAuthorGet.extend({
  name: z.string().nullable(),
  email: z.string().nullable(),
  expectedLocalName: z.string().nullable(),
  expectedLocalEmail: z.string().nullable()
})

export const RepoSetBaseRef = z.object({
  repo: requiredString('Missing repo selector'),
  ref: requiredString('Missing base ref')
})

export const RepoUpdate = createRepoUpdateSchema(RepoSelector.shape)

export const RepoSearchRefs = z.object({
  repo: requiredString('Missing repo selector'),
  query: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : undefined))
    .pipe(z.string({ message: 'Missing query' })),
  limit: OptionalFiniteNumber
})

export const RepoReorder = z.object({
  orderedIds: z.array(z.string())
})

export const ProjectGroupCreate = z.object({
  name: requiredString('Missing group name'),
  parentPath: OptionalString,
  connectionId: OptionalString.nullable().optional(),
  parentGroupId: OptionalString.nullable().optional(),
  createdFrom: z.enum(['manual', 'folder-scan', 'migration']).optional(),
  groupIcon: z.unknown().transform(sanitizeRepoIcon).optional()
})

export const ProjectGroupUpdate = z.object({
  groupId: requiredString('Missing group id'),
  updates: z.object({
    name: OptionalString,
    isCollapsed: z.boolean().optional(),
    tabOrder: OptionalFiniteNumber,
    color: OptionalString.nullable().optional(),
    groupIcon: z.unknown().transform(sanitizeRepoIcon).optional()
  })
})

export const ProjectGroupSelector = z.object({
  groupId: requiredString('Missing group id')
})

export const ProjectGroupMerge = z.object({
  sourceId: requiredString('Missing source project group'),
  targetId: requiredString('Missing target project group')
})

// Why `connectionId` is optional: older clients omit it, and older hosts strip it (bare selector).
export const ProjectGroupMoveProject = z.object({
  repo: requiredString('Missing repo selector'),
  groupId: OptionalString.nullable(),
  order: OptionalFiniteNumber,
  connectionId: z.string().nullable().optional()
})

export const ProjectGroupScanNested = z.object({
  path: requiredString('Missing folder path')
})

export const ProjectGroupImportNested = z.discriminatedUnion('mode', [
  z.object({
    parentPath: requiredString('Missing parent path'),
    groupName: z.string().optional().default(''),
    projectPaths: z.array(z.string()),
    mode: z.literal('group')
  }),
  z.object({
    parentPath: requiredString('Missing parent path'),
    // Why: blank group names fall back to the scanned folder basename; separate
    // imports do not create a group but share the same renderer payload shape.
    groupName: z.string().optional().default(''),
    projectPaths: z.array(z.string()),
    mode: z.literal('separate')
  })
])

export const RepoIssueCommandWrite = RepoSelector.extend({
  content: z.string()
})

export const RepoSparsePresetSave = RepoSelector.extend({
  id: OptionalString,
  name: requiredString('Missing preset name'),
  directories: z.array(z.string())
})
