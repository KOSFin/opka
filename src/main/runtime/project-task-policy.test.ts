import { randomUUID } from 'node:crypto'
import { spawnProcess } from '@orca/process-host'
import { once } from 'node:events'
import { captureTaskSessionPlacement } from '../project-tasks/task-attempt-placement'
import { taskResultFixture } from '../project-tasks/task-result-test-fixture'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  PROJECT_TASK_DELEGATION_CAPABILITY,
  PROJECT_TASK_PROJECT_AGENTS_CAPABILITY
} from '../../shared/project-task-delegation'
import { TaskWorkspace } from '../project-tasks/task-workspace'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { RpcDispatcher } from './rpc/dispatcher'
import { PROJECT_TASK_DELEGATION_METHODS } from './rpc/methods/project-task-delegation'
import {
  createSessionCallerHarness,
  SESSION_X,
  type SessionCallerHarness
} from './rpc/orchestration-session-caller-test-fixture'
import { closeProjectTaskWorkspaces } from './project-task-workspaces'
import { exportProjectTaskActivity, closeProjectTaskActivity } from '../project-tasks/task-activity'
import { freezeTaskResult, readTaskResult } from '../project-tasks/task-result-evidence'
import {
  projectTaskCodeSnapshot,
  verifyProjectTaskResultSource
} from './project-task-code-snapshot'
import { projectTaskResources } from './project-task-workflow-service'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { publishHostDescriptor } from './host-descriptor'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
vi.mock('../project-tasks/task-project-roots', () => ({
  resolveRegisteredTaskRoot: async (_runtime: unknown, path: string) => path
}))
vi.mock('./file-watcher-host', () => ({
  watchFileExplorerInWatcherProcess: async () => async () => {}
}))
let h: SessionCallerHarness
let root: string
let workspace: TaskWorkspace
let dispatcher: RpcDispatcher
const cap = PROJECT_TASK_DELEGATION_CAPABILITY
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-policy-'))
  h = createSessionCallerHarness(hostRef)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the local file target and its path are accessed by this synthetic folder-workspace test.
  const target = { executionHostId: 'local', worktree: { path: root } } as Awaited<
    ReturnType<typeof h.runtime.resolveRuntimeFileTarget>
  >
  vi.spyOn(h.runtime, 'resolveRuntimeFileTarget').mockResolvedValue(target)
  workspace = new TaskWorkspace(root)
  await workspace.initialize()
  await workspace.create(
    'project',
    'example',
    projectTaskTemplate({ id: 'task-11111111-1111-4111-8111-111111111111', title: 'Synthetic' })
  )
  publishHostDescriptor(h.runtime.getRuntimeId(), {
    installationId: randomUUID(),
    machineBinding: 'synthetic-machine'
  })
  dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: PROJECT_TASK_DELEGATION_METHODS })
})
afterEach(async () => {
  publishHostDescriptor(h.runtime.getRuntimeId(), null)
  await workspace.close()
  await closeProjectTaskWorkspaces(h.runtime)
  closeProjectTaskActivity(h.db.db)
  h.close()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
const target = () => ({
  worktree: `path:${root}`,
  expectedExecutionHostId: 'local',
  capability: cap
})
const proposal = () => ({
  ...target(),
  expectedGeneration: 0,
  grant: {
    grantee: `orca_session_id:${SESSION_X}`,
    actions: ['approve-plan'],
    runId: null,
    taskIds: null,
    expiresAt: Date.now() + 60_000
  }
})
const phone = {
  pairedDeviceId: 'phone',
  connectionId: 'phone-connection',
  clientKind: 'mobile' as const,
  callerScope: { kind: 'mobile' as const },
  clientCapabilities: [cap]
}
const request = (method: string, params: unknown) => ({
  id: randomUUID(),
  authToken: 'test',
  method,
  params
})
it('denies CLI/owner-token policy issuance and supplied actor fields before touching project state', async () => {
  expect((await dispatcher.dispatch(request('projectTask.policy.propose', proposal()))).ok).toBe(
    false
  )
  expect(h.runtime.resolveRuntimeFileTarget).not.toHaveBeenCalled()
  expect(
    (
      await dispatcher.dispatch(
        request('projectTask.policy.propose', {
          ...proposal(),
          caller: { kind: 'desktop' },
          ownerApproved: true
        }),
        phone
      )
    ).ok
  ).toBe(false)
  expect(h.db.db.prepare('SELECT COUNT(*) AS n FROM project_task_delegation_policy').get()?.n).toBe(
    0
  )
})
it('accepts explicit authenticated Android confirmation, pins connection, and returns manual after revoke', async () => {
  const p = await dispatcher.dispatch(request('projectTask.policy.propose', proposal()), phone)
  expect(p.ok).toBe(true)
  if (!p.ok) {
    throw new Error(p.error.message)
  }
  const parsed = z.object({ id: z.string(), digest: z.string() }).parse(p.result)
  const confirm = {
    ...target(),
    proposal: parsed.id,
    digest: parsed.digest,
    requestId: randomUUID()
  }
  expect(
    (
      await dispatcher.dispatch(request('projectTask.policy.confirm', confirm), {
        ...phone,
        connectionId: 'different'
      })
    ).ok
  ).toBe(false)
  expect(
    (await dispatcher.dispatch(request('projectTask.policy.confirm', confirm), phone)).ok
  ).toBe(true)
  const revoke = await dispatcher.dispatch(
    request('projectTask.policy.propose', { ...target(), expectedGeneration: 1, grant: null }),
    phone
  )
  if (!revoke.ok) {
    throw new Error(revoke.error.message)
  }
  const r = z.object({ id: z.string(), digest: z.string() }).parse(revoke.result)
  expect(
    (
      await dispatcher.dispatch(
        request('projectTask.policy.confirm', {
          ...target(),
          proposal: r.id,
          digest: r.digest,
          requestId: randomUUID()
        }),
        phone
      )
    ).ok
  ).toBe(true)
  expect(
    h.db.db.prepare('SELECT generation,grant_json FROM project_task_delegation_policy').get()
  ).toMatchObject({ generation: 2, grant_json: null })
})
it('requires v2 peers for project agents and persists until revoked without a synthetic grantee', async () => {
  const projectTarget = { ...target(), capability: PROJECT_TASK_PROJECT_AGENTS_CAPABILITY }
  const projectProposal = {
    ...projectTarget,
    expectedGeneration: 0,
    grant: { mode: 'project-agents' }
  }
  expect(
    (await dispatcher.dispatch(request('projectTask.policy.propose', projectProposal), phone)).ok
  ).toBe(false)
  expect(
    (
      await dispatcher.dispatch(
        request('projectTask.policy.propose', { ...projectProposal, capability: cap }),
        { ...phone, clientCapabilities: [cap, PROJECT_TASK_PROJECT_AGENTS_CAPABILITY] }
      )
    ).ok
  ).toBe(false)
  const modernPhone = {
    ...phone,
    clientCapabilities: [cap, PROJECT_TASK_PROJECT_AGENTS_CAPABILITY]
  }
  const proposed = await dispatcher.dispatch(
    request('projectTask.policy.propose', projectProposal),
    modernPhone
  )
  if (!proposed.ok) {
    throw new Error(proposed.error.message)
  }
  const parsed = z
    .object({
      id: z.string(),
      digest: z.string(),
      grant: z.object({ schema: z.literal(2), expiresAt: z.null() })
    })
    .parse(proposed.result)
  expect(parsed.grant).toEqual({ schema: 2, expiresAt: null })
  const confirmed = await dispatcher.dispatch(
    request('projectTask.policy.confirm', {
      ...projectTarget,
      proposal: parsed.id,
      digest: parsed.digest,
      requestId: randomUUID()
    }),
    modernPhone
  )
  expect(confirmed.ok).toBe(true)
  expect((await dispatcher.dispatch(request('projectTask.policy.read', target()), phone)).ok).toBe(
    false
  )
  expect(
    (
      await dispatcher.dispatch(
        request('projectTask.policy.propose', { ...target(), expectedGeneration: 1, grant: null }),
        phone
      )
    ).ok
  ).toBe(false)
  const policy = await dispatcher.dispatch(
    request('projectTask.policy.read', projectTarget),
    modernPhone
  )
  if (!policy.ok) {
    throw new Error(policy.error.message)
  }
  const current = z
    .object({ grant: z.object({ schema: z.literal(2), expiresAt: z.null() }) })
    .parse(policy.result)
  expect(current.grant).toEqual({ schema: 2, expiresAt: null })
  const revoke = await dispatcher.dispatch(
    request('projectTask.policy.propose', { ...projectTarget, expectedGeneration: 1, grant: null }),
    modernPhone
  )
  if (!revoke.ok) {
    throw new Error(revoke.error.message)
  }
  const revoked = z.object({ id: z.string(), digest: z.string() }).parse(revoke.result)
  expect(
    (
      await dispatcher.dispatch(
        request('projectTask.policy.confirm', {
          ...projectTarget,
          proposal: revoked.id,
          digest: revoked.digest,
          requestId: randomUUID()
        }),
        modernPhone
      )
    ).ok
  ).toBe(true)
  expect(
    h.db.db.prepare('SELECT generation,grant_json FROM project_task_delegation_policy').get()
  ).toMatchObject({ generation: 2, grant_json: null })
})
it('fails closed for old mobile capability, bare unverified handles, changed config and SSH host mismatch', async () => {
  expect(
    (
      await dispatcher.dispatch(request('projectTask.policy.propose', proposal()), {
        ...phone,
        clientCapabilities: []
      })
    ).ok
  ).toBe(false)
  expect(
    (
      await dispatcher.dispatch(
        request('projectTask.policy.propose', {
          ...proposal(),
          grant: { ...proposal().grant, grantee: 'term_unknown' }
        }),
        phone
      )
    ).ok
  ).toBe(false)
  expect(
    (
      await dispatcher.dispatch(
        request('projectTask.policy.propose', {
          ...proposal(),
          expectedExecutionHostId: 'ssh:other'
        }),
        phone
      )
    ).ok
  ).toBe(false)
  const p = await dispatcher.dispatch(request('projectTask.policy.propose', proposal()), phone)
  if (!p.ok) {
    throw new Error(p.error.message)
  }
  const parsed = z.object({ id: z.string(), digest: z.string() }).parse(p.result)
  await writeFile(
    join(root, '.orca/project.yaml'),
    `${await readFile(join(root, '.orca/project.yaml'), 'utf8')}\n# changed`
  )
  expect(
    (
      await dispatcher.dispatch(
        request('projectTask.policy.confirm', {
          ...target(),
          proposal: parsed.id,
          digest: parsed.digest,
          requestId: randomUUID()
        }),
        phone
      )
    ).ok
  ).toBe(false)
  expect(h.db.db.prepare('SELECT COUNT(*) AS n FROM project_task_delegation_policy').get()?.n).toBe(
    0
  )
})

it('captures exact clean Git evidence and denies dirty, untracked, unrelated and SSH sources', async () => {
  const git = (args: string[]) =>
    gitExecFileAsync(args, { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 })
  const resources = await projectTaskResources(h.runtime, `path:${root}`, 'local')
  await exportProjectTaskActivity(resources.store.native.db)
  await git(['init'])
  await git(['add', '.'])
  await git([
    '-c',
    'user.name=Synthetic',
    '-c',
    'user.email=synthetic@example.invalid',
    'commit',
    '-m',
    'Synthetic source'
  ])
  const task = resources.snapshot.tasks[0]
  const result = taskResultFixture()
  result.completeImplementation()
  result.store.transaction(() =>
    captureTaskSessionPlacement(result.store, result.implementation.id, {
      workspaceId: 'source-workspace',
      executionHostId: 'local',
      worktreePath: root,
      owner: result.implementer.actor
    })
  )
  const sourceResources = { ...resources, store: result.store }
  const context = { runtime: h.runtime }
  const snapshot = await projectTaskCodeSnapshot(
    context,
    sourceResources,
    task,
    `path:${root}`,
    result.implementation.id
  )
  expect(snapshot).toMatchObject({ dirtyDigest: null, worktreePath: root })
  const evidence = readTaskResult(result.store, result.resultDigest())
  const frozen = result.store.transaction(() =>
    freezeTaskResult(result.store, { ...evidence, kind: 'code', source: snapshot })
  )
  await verifyProjectTaskResultSource(context, sourceResources, task, frozen.digest)
  expect(() =>
    result.store.transaction(() =>
      freezeTaskResult(result.store, {
        ...evidence,
        kind: 'code',
        source: { ...snapshot, workspaceId: 'unrelated-copy' }
      })
    )
  ).toThrow(/provenance/)
  expect(snapshot.commit).toMatch(/^[a-f0-9]{40,64}$/)
  expect(snapshot.tree).toBe((await git(['rev-parse', '--verify', 'HEAD^{tree}'])).stdout.trim())
  await writeFile(join(root, 'untracked.txt'), 'Uncommitted source')
  await expect(
    projectTaskCodeSnapshot(
      context,
      sourceResources,
      task,
      `path:${root}`,
      result.implementation.id
    )
  ).rejects.toThrow(/clean committed/)
  await rm(join(root, 'untracked.txt'))
  await writeFile(join(root, '.orca/project.yaml'), '# dirty config')
  await expect(
    projectTaskCodeSnapshot(
      context,
      sourceResources,
      task,
      `path:${root}`,
      result.implementation.id
    )
  ).rejects.toThrow(/clean committed/)
  const resolveTarget = vi.mocked(h.runtime.resolveRuntimeFileTarget)
  const original = await resolveTarget(`path:${root}`)
  resolveTarget.mockResolvedValue({
    ...original,
    worktree: { ...original.worktree, path: tmpdir() }
  })
  await expect(
    projectTaskCodeSnapshot(context, sourceResources, task, 'other', result.implementation.id)
  ).rejects.toThrow(/outside/)
  resolveTarget.mockResolvedValue({ ...original, executionHostId: 'ssh:other' })
  await expect(
    projectTaskCodeSnapshot(context, sourceResources, task, 'remote', result.implementation.id)
  ).rejects.toThrow()
  resolveTarget.mockResolvedValue(original)
  await rm(join(root, '.git', 'objects', snapshot.commit.slice(0, 2), snapshot.commit.slice(2)))
  await expect(
    verifyProjectTaskResultSource(context, sourceResources, task, frozen.digest)
  ).rejects.toThrow()
  result.db.close()
})

it('refuses unrelated clean code from a second in-scope working copy for a settled attempt', async () => {
  const source = await mkdtemp(join(tmpdir(), 'source-placement-'))
  const result = taskResultFixture()
  try {
    const git = (cwd: string, args: string[]) =>
      gitExecFileAsync(args, { cwd, timeout: 10000, maxBuffer: 1024 * 1024 })
    await git(root, ['init'])
    await git(root, ['add', '.'])
    await git(root, [
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      'commit',
      '-m',
      'Baseline'
    ])
    await git(root, ['worktree', 'add', '--detach', source, 'HEAD'])
    await writeFile(join(source, 'implementation.txt'), 'The actual attempt result')
    await git(source, ['add', '.'])
    await git(source, [
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      'commit',
      '-m',
      'Implementation'
    ])
    expect((await git(root, ['rev-parse', 'HEAD'])).stdout).not.toBe(
      (await git(source, ['rev-parse', 'HEAD'])).stdout
    )
    result.completeImplementation()
    result.store.transaction(() =>
      captureTaskSessionPlacement(result.store, result.implementation.id, {
        workspaceId: 'actual-source',
        executionHostId: 'local',
        worktreePath: source,
        owner: result.implementer.actor
      })
    )
    const resources = await projectTaskResources(h.runtime, `path:${root}`, 'local')
    await expect(
      projectTaskCodeSnapshot(
        { runtime: h.runtime },
        { ...resources, store: result.store },
        resources.snapshot.tasks[0],
        `path:${root}`,
        result.implementation.id
      )
    ).rejects.toThrow(/placement|provenance/)
  } finally {
    result.db.close()
    await rm(source, { recursive: true, force: true })
  }
})

it.each(['propose', 'confirm'] as const)(
  'serializes policy %s behind a separate process editing the config',
  async (phase) => {
    const p = await dispatcher.dispatch(request('projectTask.policy.propose', proposal()), phone)
    if (!p.ok) {
      throw new Error(p.error.message)
    }
    const parsed = z.object({ id: z.string(), digest: z.string() }).parse(p.result)
    const marker = join(root, 'lock-ready')
    const child = spawnProcess({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      args: [
        '-e',
        String.raw`
      const fs = require('node:fs');
      require('proper-lockfile').lock(process.argv[1], {realpath:false}).then(release => {
        fs.writeFileSync(process.argv[2], 'ready');
        process.stdin.once('data', async () => {
          fs.appendFileSync(process.argv[3], '\n# cooperative edit');
          await release(); process.exit(0);
        });
      }).catch(() => process.exit(2));
    `,
        join(root, '.orca/project-tasks'),
        marker,
        join(root, '.orca/project.yaml')
      ],
      cwd: process.cwd(),
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    const closed = once(child, 'close')
    try {
      await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('ready'))
      let settled = false
      const pending = dispatcher
        .dispatch(
          request(
            `projectTask.policy.${phase}`,
            phase === 'propose'
              ? proposal()
              : { ...target(), proposal: parsed.id, digest: parsed.digest, requestId: randomUUID() }
          ),
          phone
        )
        .then((reply) => {
          settled = true
          return reply
        })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(settled).toBe(false)
      child.stdin?.write('edit')
      await closed
      const reply = await pending
      if (phase === 'confirm') {
        expect(reply.ok).toBe(false)
      }
      expect(
        h.db.db.prepare('SELECT COUNT(*) AS n FROM project_task_delegation_policy').get()?.n
      ).toBe(0)
    } finally {
      child.stdin?.write('edit')
      child.kill()
      await closed
    }
  }
)
