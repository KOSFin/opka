export const REPO_GIT_AUTHOR_RUNTIME_CAPABILITY = 'repo.git-author.v1'

export type RepoGitAuthorField = {
  effective: string | null
  local: string | null
  origin: 'local' | 'inherited' | 'unset'
}

export type RepoGitAuthor = {
  name: RepoGitAuthorField
  email: RepoGitAuthorField
}

export type RepoGitAuthorUpdate = {
  name: string | null
  email: string | null
  expectedLocalName: string | null
  expectedLocalEmail: string | null
}
