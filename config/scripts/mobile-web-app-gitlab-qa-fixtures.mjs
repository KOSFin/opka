import { readFileSync } from 'node:fs'

function decodeRecorded(value) {
  if (Array.isArray(value)) {
    return value.map(decodeRecorded)
  }
  if (value && typeof value === 'object') {
    if (value.$rpc === 'null') {
      return null
    }
    if (value.$rpc === 'undefined' || value.$rpc === 'absent') {
      return undefined
    }
    if ('$rpc' in value) {
      throw new Error('Unexpected recording token in QA fixture')
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decodeRecorded(entry)])
    )
  }
  return value
}
function recordedNormalResult(filename, method) {
  const golden = JSON.parse(
    readFileSync(
      new URL(`../../mobile/rpc-foundation/goldens/${filename}`, import.meta.url),
      'utf8'
    )
  )
  const checkpoint = golden.recording.checkpoints.find((entry) => entry.id.includes('.normal:'))
  const sender = checkpoint?.observation.sender
    .map((key) => golden.values[key])
    .find((entry) => entry.args?.some((arg) => arg.name === 'method' && arg.value === method))
  if (sender?.settlement?.value?.ok !== true) {
    throw new Error(`No successful normal recording for ${method}`)
  }
  return decodeRecorded(sender.settlement.value.result)
}
const recordedList = recordedNormalResult(
  'matrix-tasks.task-list-gitlab-items-gitlab.listworkitems-1.json',
  'gitlab.listWorkItems'
)
const recordedDetail = recordedNormalResult(
  'matrix-tasks.item-detail-gitlab-gitlab.workitemdetails-1.json',
  'gitlab.workItemDetails'
)
export const gitLabQaItem = {
  ...recordedList.items[0],
  id: 'mr:4',
  type: 'mr',
  title: 'Synthetic GitLab MR',
  author: 'Synthetic author',
  projectRef: { host: 'gitlab.example.invalid', path: 'group/project' },
  branchName: 'feature/qa',
  baseRefName: 'main',
  url: 'https://gitlab.example.invalid/group/project/-/merge_requests/4'
}
export const gitLabQaReplies = {
  'settings.get': {
    settings: {
      defaultTaskSource: 'gitlab',
      visibleTaskProviders: ['gitlab'],
      defaultRepoSelection: ['repo-1']
    }
  },
  'ui.get': { ui: { taskResumeState: {} } },
  'ui.set': {},
  'preflight.check': { glab: { installed: true } },
  'linear.status': { connected: false },
  'jira.status': { connected: false },
  'repo.list': {
    repos: [{ id: 'repo-1', displayName: 'Synthetic repo', path: '/synthetic/repo', kind: 'git' }]
  },
  'gitlab.listWorkItems': { ...recordedList, items: [gitLabQaItem] },
  'gitlab.workItemDetails': {
    ...recordedDetail,
    body: '# Synthetic MR details\n\nRetained MR body from the recorded RPC envelope.',
    assignees: ['owner'],
    reviewers: [{ username: 'reviewer', name: 'Synthetic reviewer', avatarUrl: '' }],
    files: [
      {
        path: 'new.ts',
        oldPath: 'old.ts',
        status: 'renamed',
        additions: 3,
        deletions: 2,
        isBinary: false
      }
    ],
    pipelineJobs: [{ id: 1, name: 'verify', stage: 'test', status: 'success' }]
  }
}
