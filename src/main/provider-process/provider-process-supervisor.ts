import { resolveProviderChildEnv, type ProviderProcessLaunch } from './provider-process-launch'
import { buildPosixProviderSupervisorScript } from './provider-posix-supervisor-script'

/** Time the provider gets to exit on its own after its stdin ends, before SIGTERM. */
export const PROVIDER_STDIN_END_GRACE_MS = 1_000
/** Time the provider group gets to flush and exit after SIGTERM, before SIGKILL. */
export const PROVIDER_SIGTERM_GRACE_MS = 3_000
/**
 * How long the supervisor waits for a SIGKILLed group to disappear. A killed process never runs
 * again, so this only covers the kernel finishing the kill; waiting forever could hang close or
 * recovery on a process stuck in the kernel, such as one blocked on a hung network drive.
 */
export const PROVIDER_GROUP_REAP_TIMEOUT_MS = 1_500
/** Longest a supervisor waits, after its provider exits, to relay output still in the pipes. */
export const PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS = 1_000
/**
 * Longest a supervisor can take to stop once asked (stdin end, grace, SIGTERM, grace, SIGKILL,
 * reap); a SIGKILL sooner can orphan its group. The graces are also the largest a spec may carry.
 */
export const PROVIDER_SUPERVISOR_MAX_STOP_MS =
  PROVIDER_STDIN_END_GRACE_MS + PROVIDER_SIGTERM_GRACE_MS + PROVIDER_GROUP_REAP_TIMEOUT_MS

export const POSIX_PROVIDER_SUPERVISOR_SCRIPT = buildPosixProviderSupervisorScript({
  groupReapTimeoutMs: PROVIDER_GROUP_REAP_TIMEOUT_MS,
  outputDrainTimeoutMs: PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS
})

/**
 * `session`: the owner ending stdin is a close, so the provider is stopped after a grace.
 * `one-shot`: stdin end only completes the request; the provider runs until it exits or is stopped.
 */
export type ProviderSupervisorLifetime = 'session' | 'one-shot'

/**
 * How a provider's owner closes it: by ending its stdin, after which a session gets its grace (a
 * drain), or by ending stdin and sending SIGTERM at once (`signalSupervisorOnClose` in its close
 * policy). A gone owner gets the same request.
 */
export type ProviderCloseRequest = 'stdin-end' | 'stdin-end-and-sigterm'

export type ProviderSupervisorOptions = {
  cwd?: string
  lifetime?: ProviderSupervisorLifetime
  /** Defaults to the immediate stop; a provider that drains on its stdin end opts into 'stdin-end'. */
  closeRequest?: ProviderCloseRequest
  /** The process the supervisor serves; it must be the supervisor's parent. */
  ownerPid?: number
  stdinEndGraceMs?: number
  sigtermGraceMs?: number
}

// The user's Node startup options, as the CLI launchers stash them away from Electron's bootstrap.
const PROVIDER_ONLY_NODE_ENV_KEYS = ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE'] as const

// A longer grace than the max stop allows would let recovery or close SIGKILL mid-stop.
function assertGraceWithin(name: string, graceMs: number, maxMs: number): void {
  if (!(graceMs >= 0 && graceMs <= maxMs)) {
    throw new RangeError(`Provider supervisor ${name} grace ${graceMs} ms is outside 0-${maxMs} ms`)
  }
}

// `never` makes an env-bearing launch a type error here: env is resolved before supervision.
type ProviderSupervisedCommand = Pick<ProviderProcessLaunch, 'command' | 'args' | 'cwd'> & {
  env?: never
  envToDelete?: never
}

export function supervisedPosixLaunch(
  launch: ProviderSupervisedCommand,
  childEnv: NodeJS.ProcessEnv,
  {
    cwd = launch.cwd ?? process.cwd(),
    ownerPid = process.pid,
    lifetime = 'session',
    closeRequest = 'stdin-end-and-sigterm',
    stdinEndGraceMs = PROVIDER_STDIN_END_GRACE_MS,
    sigtermGraceMs = PROVIDER_SIGTERM_GRACE_MS
  }: ProviderSupervisorOptions = {}
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  assertGraceWithin('stdin-end', stdinEndGraceMs, PROVIDER_STDIN_END_GRACE_MS)
  assertGraceWithin('SIGTERM', sigtermGraceMs, PROVIDER_SIGTERM_GRACE_MS)
  // Only small fields ride in the env: Linux caps one env string at 128 KiB, and argv prompts near it.
  // Electron's Node bootstrap honours these too; held in the spec, they reach only the provider.
  const supervisorEnv = { ...childEnv }
  const nodeEnv: Record<string, string> = {}
  for (const key of PROVIDER_ONLY_NODE_ENV_KEYS) {
    const value = supervisorEnv[key]
    delete supervisorEnv[key]
    if (value !== undefined) {
      nodeEnv[key] = value
    }
  }
  const supervisorSpec = Buffer.from(
    JSON.stringify({
      cwd,
      ownerPid,
      lifetime,
      closeRequest,
      stdinEndGraceMs,
      sigtermGraceMs,
      nodeEnv
    })
  ).toString('base64')
  return {
    command: process.execPath,
    args: ['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT, '--', launch.command, ...launch.args],
    // Electron's executable needs Node mode for the inline supervisor. The
    // marker is removed above so providers never inherit Electron semantics.
    env: {
      ...supervisorEnv,
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_PROVIDER_SUPERVISOR_SPEC: supervisorSpec
    }
  }
}

export function createProviderSpawnSpec(
  launch: ProviderProcessLaunch,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  { lifetime, closeRequest }: Pick<ProviderSupervisorOptions, 'lifetime' | 'closeRequest'> = {}
): {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  detached: boolean
  /** The child is the supervisor, whose SIGTERM stops the provider and then itself. */
  supervised: boolean
  /** Appended after the three standard slots: the channel the supervisor reports its group on. */
  groupReportStdio: [] | ['ipc']
} {
  const childEnv = resolveProviderChildEnv(launch, baseEnv)
  const supervisor =
    platform === 'win32'
      ? null
      : supervisedPosixLaunch(
          { command: launch.command, args: launch.args, cwd: launch.cwd },
          childEnv,
          { lifetime, closeRequest }
        )
  return {
    program: supervisor?.command ?? launch.command,
    args: supervisor?.args ?? launch.args,
    env: supervisor?.env ?? childEnv,
    cwd: launch.cwd ?? process.cwd(),
    detached: platform !== 'win32',
    supervised: supervisor !== null,
    groupReportStdio: supervisor ? ['ipc'] : []
  }
}
