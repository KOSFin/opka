import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { prepareAcceptanceFixture } from './fork-acceptance-fixture.mjs'
import { repairAcceptanceProject } from './fork-acceptance-project-repair.mjs'
import { readRemoteAcceptanceConfig } from './fork-acceptance-remote-config.mjs'

const remoteSshArgs = ({ host, username, identityFile }) => [
  '-i',
  identityFile,
  '-l',
  username,
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'StrictHostKeyChecking=yes',
  host
]

export function stageRemoteAcceptance(area, profile) {
  const config = readRemoteAcceptanceConfig()
  const { host, username, identityFile, remoteRoot } = config
  const sshArgs = remoteSshArgs(config)
  if (!existsSync(identityFile)) {
    throw new Error('Existing audit SSH identity is required; never copy it into the profile')
  }
  const [user, fixtureState] = execFileSync(
    '/usr/bin/ssh',
    [
      ...sshArgs,
      `id -un; if test -e ${remoteRoot}; then test -f ${remoteRoot}/.fork-acceptance.json || exit 1; printf registered; else printf missing; fi`
    ],
    { encoding: 'utf8', timeout: 20000 }
  )
    .trim()
    .split('\n')
  if (user !== username) {
    throw new Error('Unexpected SSH account')
  }
  if (fixtureState !== 'registered') {
    const fixture = path.join(area, 'remote-fixture')
    prepareAcceptanceFixture(fixture)
    const archive = execFileSync('/usr/bin/tar', ['--no-xattrs', '-cf', '-', '-C', fixture, '.'])
    execFileSync(
      '/usr/bin/ssh',
      [
        ...sshArgs,
        `umask 077; if test ! -e ${remoteRoot}; then mkdir -p ${remoteRoot} && tar -xf - -C ${remoteRoot}; else test -f ${remoteRoot}/.fork-acceptance.json && tar -tf - >/dev/null; fi`
      ],
      { input: archive, timeout: 30000 }
    )
  }
  const sshDir = path.join(profile, 'home/.ssh')
  mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  const knownHost = execFileSync('/usr/bin/ssh-keygen', ['-F', host], { encoding: 'utf8' })
  if (!knownHost.includes(host)) {
    throw new Error('Verified known_hosts entry required')
  }
  writeFileSync(path.join(sshDir, 'known_hosts'), knownHost, { mode: 0o600 })
}

export async function connectRemoteAcceptance(page, previous) {
  const { host, username, identityFile, remoteRoot } = readRemoteAcceptanceConfig()
  const result = await page.evaluate(
    async ({
      host,
      username,
      identityFile,
      remoteRoot,
      previous,
      preserveDaemonUpdate,
      probeManualTasks
    }) => {
      const stages = []
      const timed = async (phase, action) => {
        const started = performance.now()
        console.info(`[fork-remote-stage] ${JSON.stringify({ phase, state: 'started' })}`)
        try {
          return await action()
        } finally {
          const stage = { phase, ms: Math.round(performance.now() - started) }
          stages.push(stage)
          console.info(`[fork-remote-stage] ${JSON.stringify(stage)}`)
        }
      }
      const target = previous?.sshTargetId
        ? { id: previous.sshTargetId }
        : (
            await window.api.ssh.addTarget({
              target: {
                label: 'NEW SERVER — Fork acceptance',
                host,
                port: 22,
                username,
                identityFile,
                identitiesOnly: true
              }
            })
          ).target
      const connected = await timed('ssh.initialConnect', () =>
        window.api.ssh.connect({ targetId: target.id })
      )
      if (connected.status !== 'connected') {
        throw new Error('SSH did not connect')
      }
      let environment
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        const entries = await timed('runtime.list', () => window.api.runtimeEnvironments.list())
        environment = entries.find((entry) => entry.orcadDeployment?.sshTargetId === target.id)
        if (environment) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      if (!environment) {
        throw new Error('Isolated managed runtime did not become available')
      }
      if (preserveDaemonUpdate) {
        const status = await window.api.runtimeEnvironments.managedOrcad.getStatus({
          selector: environment.id
        })
        if (
          status.terminals.liveSessions === null ||
          status.terminals.daemonProtocolVersion === null ||
          (status.terminals.inProcessSessions ?? 0) > 0
        ) {
          throw new Error('Cannot confirm safe daemon preservation; update refused')
        }
        const updated = await window.api.runtimeEnvironments.managedOrcad.update({
          selector: environment.id,
          force: true
        })
        if (updated.outcome === 'deferred') {
          throw new Error(`Managed update deferred: ${updated.code}`)
        }
      }
      const call = async (method, params = {}) => {
        const response = await timed(`rpc.${method}`, () =>
          window.api.runtimeEnvironments.call({
            selector: environment.id,
            method,
            params
          })
        )
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        return response.result
      }
      const groups = await call('projectGroup.list')
      let group = groups.groups.find(
        (entry) => entry.name === 'REMOTE — Fork acceptance' && entry.parentPath === remoteRoot
      )
      if (!group) {
        group = (
          await call('projectGroup.create', {
            name: 'REMOTE — Fork acceptance',
            parentPath: remoteRoot
          })
        ).group
      }
      const folders = await call('folderWorkspace.list')
      let folder = folders.folderWorkspaces.find((entry) => entry.folderPath === remoteRoot)
      if (!folder) {
        folder = (
          await call('folderWorkspace.create', {
            projectGroupId: group.id,
            name: 'REMOTE — учебные задачи',
            folderPath: remoteRoot
          })
        ).folderWorkspace
      }
      const scan = await call('projectGroup.scanNested', { path: remoteRoot })
      if (scan.repos.length !== 3) {
        throw new Error('Remote nested scan did not find three repositories')
      }
      const imported = await call('projectGroup.importNested', {
        parentPath: remoteRoot,
        groupName: 'REMOTE — Fork acceptance',
        mode: 'group',
        projectPaths: scan.repos.map((entry) => entry.path)
      })
      if (imported.failedCount) {
        throw new Error('Remote nested import failed')
      }
      const tasks = await call('projectTask.list', {
        worktree: `folder:${folder.id}`,
        offset: 0,
        limit: 100
      })
      if (tasks.total < 3 || tasks.diagnostics.length) {
        throw new Error('Remote synthetic task index failed')
      }
      const childTasks = await call('projectTask.list', {
        worktree: `path:${remoteRoot}/apps/web`,
        offset: 0,
        limit: 100
      })
      if (childTasks.total !== tasks.total || childTasks.diagnostics.length) {
        throw new Error('Child checkout did not resolve its overall task project')
      }
      let manualProbe
      if (probeManualTasks) {
        const worktree = `folder:${folder.id}`
        const { executionHostId } = await call('projectTask.target', { worktree })
        const uuid = crypto.randomUUID()
        const id = `task-${uuid}`
        const created = await call('projectTask.create', {
          worktree,
          expectedExecutionHostId: executionHostId,
          source: tasks.project.sources[0].id,
          slug: `manual-probe-${uuid}`,
          content: `---\nschema: 1\nid: ${id}\ntitle: Synthetic manual workflow probe\nkind: investigation\nrepos: []\n---\n# Goal\nVerify manual task lifecycle; no agent, production write or deployment.\n`
        })
        const action = {
          worktree,
          expectedExecutionHostId: executionHostId,
          id,
          revision: created.revision
        }
        let documentRemoved = false
        try {
          await call('projectTask.move', { ...action, phase: 'active' })
          const active = await call('projectTask.workflow', { worktree, id })
          if (active.phase !== 'active' || active.attempts.length) {
            throw new Error('Manual work fabricated a managed attempt')
          }
          await call('projectTask.move', {
            ...action,
            phase: 'done',
            reason: 'Synthetic operator verified this RPC cycle only; no CI or deployment claim.'
          })
          const done = await call('projectTask.workflow', { worktree, id })
          if (done.phase !== 'done' || done.attempts.length) {
            throw new Error('Manual task completion was not retained')
          }
          manualProbe = {
            projectWide: created.repos.length === 0,
            manualDone: true,
            managedAttempts: 0
          }
        } finally {
          const removed = await call('projectTask.delete', action)
          documentRemoved = removed.deleted === true
        }
        if (!documentRemoved) {
          throw new Error('Synthetic task document cleanup was not confirmed')
        }
        if ((await call('projectTask.list', { worktree })).total !== tasks.total) {
          throw new Error('Synthetic probe changed the original task count')
        }
        manualProbe.documentRemovedHistoryRetained = true
      }
      await timed('ssh.disconnect', () => window.api.ssh.disconnect({ targetId: target.id }))
      const again = await timed('ssh.reconnect', () =>
        window.api.ssh.connect({ targetId: target.id })
      )
      if (again.status !== 'connected') {
        throw new Error('Remote reconnect failed')
      }
      const after = await call('projectTask.list', {
        worktree: `folder:${folder.id}`,
        offset: 0,
        limit: 100
      })
      if (after.total !== tasks.total) {
        throw new Error('Remote tasks lost on reconnect')
      }
      const status = await timed('runtime.managedStatus', () =>
        window.api.runtimeEnvironments.managedOrcad.getStatus({
          selector: environment.id
        })
      )
      return {
        stages,
        environmentId: environment.id,
        sshTargetId: target.id,
        remoteRoot,
        taskCount: after.total,
        childCheckoutResolved: true,
        ...(manualProbe ? { manualProbe } : {}),
        activeVersion: status.activeVersion,
        liveSessions: status.terminals.liveSessions,
        reconnected: true,
        username
      }
    },
    {
      host,
      username,
      identityFile,
      remoteRoot,
      previous,
      preserveDaemonUpdate: process.env.ORCA_ACCEPTANCE_PRESERVE_DAEMON_UPDATE === '1',
      probeManualTasks: process.env.ORCA_ACCEPTANCE_PROBE_MANUAL_TASKS === '1'
    }
  )
  const projectRepair = await repairAcceptanceProject(page, {
    environmentId: result.environmentId,
    root: remoteRoot,
    folderId: await page.evaluate(
      async ({ environmentId, remoteRoot }) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'folderWorkspace.list'
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        return response.result.folderWorkspaces.find((entry) => entry.folderPath === remoteRoot)?.id
      },
      { environmentId: result.environmentId, remoteRoot }
    )
  })
  return { ...result, projectRepair }
}
