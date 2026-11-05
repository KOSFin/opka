import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { createClaudeNativePrintGatewayFixture } from './claude-native-print-gateway-fixture'
import { startClaudeNativeGatewayHttp } from './claude-native-gateway-http'
import { createNativeClaudeGatewayRouteSession } from '../runtime/native-claude-gateway-route-session'
import { createNativeClaudeQuotaConfirmation } from '../runtime/native-claude-quota-confirmation'
import {
  readNativeCliStdioOwner,
  readNativeCliStdioObservationOwner
} from '../runtime/native-cli-stdio-owner'
import { startNativeCliStdio, requireNativeCliStdioSession } from '../runtime/native-cli-stdio-host'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { readNativePrintResultSummary } from './claude-native-stdio-rewake-prototype'

const enabled = process.platform === 'linux' && process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE === '1'
it.skipIf(!enabled)(
  'preserves one native JSON result and accepted tool history across a confirmed rejected-request account transfer',
  async () => {
    const executable = process.env.OPKA_SYNTHETIC_CLAUDE_BINARY
    if (!executable) {
      throw new Error('An explicit pinned synthetic native binary is required.')
    }
    const digest = createHash('sha256')
    for await (const bytes of createReadStream(executable)) {
      digest.update(bytes)
    }
    expect(digest.digest('hex')).toBe(
      '708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd'
    )
    const f = await createClaudeNativePrintGatewayFixture(executable)
    let stdout = '',
      stderr = '',
      exitCode: number | undefined,
      deadlineStopped = false
    let proof = () => false
    const decisions: { eligible: boolean; quota: boolean }[] = []
    const selected: string[] = []
    const routeSession = createNativeClaudeGatewayRouteSession({
      launchId: f.launchId,
      initialAccountId: f.initialAssignment.accountId,
      initialOwnerKey: f.initialAssignment.ownerKey,
      db: f.db,
      sources: f.sources,
      acquireAssignment: f.acquireAssignment,
      readCandidates: f.readCandidates,
      readPolicy: () => f.policy,
      readOwner: f.readOwner,
      isCurrent: () => !!readNativeCliStdioObservationOwner(f.runtime, f.launchId),
      canReplace: () => proof(),
      onAccountSelected: (selection) => {
        selected.push(selection.accountId)
      }
    })
    const gateway = await startClaudeNativeGatewayHttp({
      capability: f.capability,
      nativeAccountUuid: f.initialAccess.identity.accountUuid,
      totalTimeoutMs: 20_000,
      prepare: async (request, signal) => {
        if (request.sessionId !== f.readOwner()?.sessionId) {
          throw new Error('Native provider session does not match its actual canonical owner.')
        }
        return routeSession.prepareCurrent(signal)
      },
      retryRejected: async ({ route, excludedQuotaIdentities, signal }) => {
        proof = f.readProof()
        const owner = f.readOwner(),
          promptId = f.readCoverage()?.currentMainPromptId
        if (!owner || !promptId || !proof()) {
          decisions.push({ eligible: false, quota: false })
          return null
        }
        const access = await f.sources.refresh(route.accountId, signal)
        f.sources.assertAccountOwned(route.accountId)
        if (!proof() || access.identity.accountUuid !== route.accountUuid) {
          return null
        }
        const confirm = createNativeClaudeQuotaConfirmation({
          readCurrent: () =>
            f.readOwner()?.identity === owner.identity
              ? {
                  accountId: route.accountId,
                  sessionId: owner.sessionId,
                  owner: owner.identity,
                  access
                }
              : null,
          refresh: (id, signal) => f.sources.refresh(id, signal),
          assertAccountOwned: (id) => f.sources.assertAccountOwned(id)
        })
        try {
          const quota = await confirm.confirm(
            { accountId: route.accountId, sessionId: owner.sessionId, promptId },
            proof,
            signal
          )
          decisions.push({ eligible: proof(), quota })
          return quota && proof()
            ? routeSession.prepareReplacement(new Set(excludedQuotaIdentities), signal)
            : null
        } finally {
          confirm.close()
        }
      }
    })
    f.setActiveHttp(gateway.readActiveRequests)
    const launch = f.interceptLaunch(gateway.baseUrl)
    let deadline: ReturnType<typeof setTimeout> | undefined
    let detach: (() => void) | undefined
    try {
      const result = await startNativeCliStdio(f.runtime, {
        launchId: f.launchId,
        executable,
        cwd: f.root,
        args: [
          '-p',
          'synthetic-print-gateway-original',
          '--model',
          'claude-sonnet-4-5',
          '--output-format',
          'json',
          '--strict-mcp-config',
          '--no-session-persistence',
          '--dangerously-skip-permissions'
        ],
        env: {
          HOME: f.root,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1'
        }
      })
      const session = requireNativeCliStdioSession(f.runtime, result.launchId, result.generation)
      expect(readNativeCliStdioOwner(f.runtime, f.launchId)?.process.pid).toBe(session.group?.pgid)
      session.attached = true
      detach = session.output.attach((frame) => {
        if (frame.type === 'native-stdio-exit') {
          exitCode = frame.code
          return
        }
        const value = Buffer.from(frame.bytes, 'base64').toString()
        if (stdout.length + stderr.length + value.length > 512 * 1024) {
          throw new Error('Native fixture output exceeded its private bound.')
        }
        if (frame.channel === 'stdout') {
          stdout += value
        } else {
          stderr += value
        }
        session.output.acknowledge(frame.sequence)
      })
      await session.control({ ...result, sequence: 0, inputSequence: 1, eof: true })
      deadline = setTimeout(() => {
        deadlineStopped = true
        void session.close()
      }, 25_000)
      await session.done
      clearTimeout(deadline)
      expect(deadlineStopped).toBe(false)
      expect(readNativePrintResultSummary(stdout, 'json')).toEqual({
        valid: true,
        resultCount: 1,
        errorCount: 0,
        lastError: false
      })
      expect(exitCode).toBe(0)
      expect(f.provider.map((request) => request.account)).toEqual(['A', 'A', 'B'])
      expect(
        f.provider.every(
          (request) =>
            request.identity && request.originalCount === 1 && !request.localCapabilityLeaked
        )
      ).toBe(true)
      expect(f.provider.slice(1).every((request) => request.toolResult)).toBe(true)
      expect(f.usage).toEqual([{ account: 'A' }])
      expect(decisions).toEqual([{ eligible: true, quota: true }])
      expect(selected).toEqual(['B'])
      expect(routeSession.accountId).toBe('B')
      expect(
        f.db
          .listAccountPoolAssignments()
          .filter((assignment) => !assignment.releasedAt)
          .map((assignment) => assignment.accountId)
      ).toEqual(['B'])
      expect(await f.opaqueOnly()).toBe(true)
      expect(f.healthy()).toBe(true)
      expect(f.store.listRecords()).toHaveLength(0)
    } finally {
      clearTimeout(deadline)
      detach?.()
      launch.mockRestore()
      const receipt = {
        output: readNativePrintResultSummary(stdout, 'json'),
        exitCode,
        deadlineStopped,
        provider: f.provider,
        usage: f.usage,
        decisions,
        selected,
        observed: f.observed,
        opaqueOnly: await f.opaqueOnly(),
        sourceRefresh:
          'existing source API uses isolated fresh synthetic source-read seam; native sole-writer authority independently qualified'
      }
      if (process.env.OPKA_NATIVE_GATEWAY_RECEIPT) {
        await writeFile(process.env.OPKA_NATIVE_GATEWAY_RECEIPT, JSON.stringify(receipt, null, 2), {
          mode: 0o600
        })
      }
      if (process.env.OPKA_NATIVE_GATEWAY_OUTPUT) {
        await writeFile(process.env.OPKA_NATIVE_GATEWAY_OUTPUT, `${stdout}\nSTDERR\n${stderr}`, {
          mode: 0o600
        })
      }
      const absent = await f.stopNative()
      await gateway.close()
      routeSession.dispose({ releaseCurrent: absent })
      if (absent) {
        f.scope.close()
      }
      await f.dispose()
      closeTestJournalHostDatabases()
    }
  },
  45_000
)
