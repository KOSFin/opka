import { readFileSync } from 'node:fs'
const protocolSource = readFileSync(
  new URL('../../src/shared/protocol-version.ts', import.meta.url),
  'utf8'
)
function protocolConstant(name) {
  const match = new RegExp(`export const ${name} = ([0-9]+)`).exec(protocolSource)
  if (!match) {
    throw new Error(`Missing runtime protocol constant ${name}`)
  }
  return Number(match[1])
}
const revision = 'a'.repeat(64)
function task(id, title, phase) {
  return {
    id,
    title,
    revision,
    path: `docs/work/tasks/${id}/task.md`,
    workflow: {
      phase,
      archived: false,
      revisionChanged: false,
      attempts: [],
      events: [
        {
          sequence: 1,
          kind: 'created',
          detail: 'Task created for review',
          createdAt: '2026-10-31T10:00:00Z'
        }
      ]
    }
  }
}
export const projectWorkAccountSnapshot = {
  claude: { accounts: [], activeAccountId: null },
  codex: {
    accounts: [
      {
        id: 'codex-test',
        email: 'test@example.invalid',
        managedHomeRuntime: 'host',
        wslDistro: null,
        updatedAt: 10
      }
    ],
    activeAccountId: 'codex-test',
    activeAccountIdsByRuntime: { host: 'codex-test', wsl: {} }
  },
  rateLimits: {
    claude: null,
    codex: null,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}
const waiting = {
  id: '23b77931-bc24-41e6-9e65-9bd427458be9',
  provider: 'codex',
  status: 'waiting',
  verificationUrl: 'https://auth.openai.com/codex/device',
  userCode: 'TEST-ABCDE',
  expiresAt: 2_000_000_000_000
}
export const projectWorkRenderReplies = {
  'status.get': {
    protocolVersion: protocolConstant('RUNTIME_PROTOCOL_VERSION'),
    minCompatibleMobileVersion: protocolConstant('MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION'),
    appVersion: '1.4.236-rc.7',
    hostPlatform: 'linux',
    machineName: 'Opka test server',
    capabilities: ['accounts.device-sign-in.v1', 'orchestration.account-pools.v1']
  },
  'projectTask.catalog': {
    projects: [{ selector: 'folder:/test', name: 'Website integration', state: 'configured' }],
    truncated: false
  },
  'projectTask.board': {
    project: { id: 'project-test' },
    executionHostId: 'runtime:test',
    total: 3,
    tasks: [
      task('review', 'Connect the website to the control panel', 'review'),
      task('planned', 'Document the API contract', 'ready'),
      task('active', 'Verify mobile navigation', 'active')
    ]
  },
  'projectTask.show': {
    id: 'review',
    revision,
    body: '# Connect the website\n\nUse the approved API contract. Verify the integration and save a report.'
  },
  'projectTask.documents': {
    paths: ['reports/result.md'],
    path: 'reports/result.md',
    content: '# Integration result\n\nThe synthetic contract checks passed.'
  },
  'worktree.list': {
    worktrees: [
      { id: 'folder:render-sign-in', displayName: 'Sign-in workspace', path: '/synthetic/sign-in' }
    ]
  },
  'accounts.openSignInTerminal': {
    terminal: {
      handle: 'term-sign-in',
      worktreeId: 'folder:render-sign-in',
      tabId: 'tab-sign-in',
      leafId: 'leaf-sign-in',
      executionHostId: 'runtime:render-check-host'
    }
  },
  'preflight.detectAgents': [],
  'accounts.list': projectWorkAccountSnapshot,
  'accounts.beginDeviceSignIn': waiting,
  'accounts.deviceSignIn': waiting,
  'accounts.cancelDeviceSignIn': { ...waiting, status: 'cancelled' },
  'native.clipboard.write': { written: true },
  'accountPool.list': {
    capability: 'orchestration.account-pools.v1',
    policies: [
      {
        id: 'codex-default',
        provider: 'codex',
        revision: 1,
        strategy: 'balanced',
        applyToNewWork: true,
        rotation: 'after-turn',
        unknownQuota: 'allow',
        allowReserve: false,
        members: [
          { accountId: 'codex-test', priority: 1, weight: 1, state: 'enabled', role: 'primary' }
        ]
      }
    ],
    accounts: {
      claude: { accounts: [], activeAccountId: null },
      codex: {
        accounts: [{ id: 'codex-test', email: 'test@example.invalid' }],
        activeAccountId: 'codex-test'
      }
    },
    candidates: [
      {
        provider: 'codex',
        accountId: 'codex-test',
        auth: 'ready',
        quota: 'available',
        usedPercent: 10
      }
    ],
    assignments: []
  }
}
