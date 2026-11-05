import { z } from 'zod'
import { TerminalTaskCallerEvidence } from './terminal-task-caller-identity'

export const NativeCliAccountLaunchParams = z
  .object({
    provider: z.enum(['claude', 'codex']),
    launchId: z.uuid(),
    accountId: z.string().min(1).max(256).optional(),
    initialAssignmentOwnerKey: z.string().min(1).max(256).optional(),
    claudeExecutable: z.string().min(1).max(8192).optional(),
    codexExecutable: z.string().min(1).max(8192).optional(),
    codexWorkingDirectory: z.string().min(1).max(8192).optional(),
    codexModelCatalogPath: z.string().min(1).max(8192).optional(),
    codexResumeSessionId: z.uuid().optional(),
    codexProfile: z.string().min(1).max(256).optional(),
    codexModelProvider: z.string().min(1).max(256).optional(),
    interactive: z.boolean().optional(),
    stdio: z.boolean().optional(),
    parentContextExpected: z.boolean().optional(),
    parentTerminal: TerminalTaskCallerEvidence.optional()
  })
  .strict()

export type NativeCliAccountLaunchRequest = z.infer<typeof NativeCliAccountLaunchParams>

export const NativeCliAccountReleaseParams = z.object({ launchId: z.uuid() }).strict()

export type NativeCliAccountLaunch = {
  env: Record<string, string>
  envToDelete: string[]
  launchId: string
  accountId: string | null
  poolId: string | null
  policyRevision: number | null
  codexConfigOverrides?: string[]
  claudePluginDirs?: string[]
  executionMode?: 'inherit' | 'host-pty' | 'host-stdio'
}

export const NATIVE_CLI_ACCOUNT_PIN_ENV = 'ORCA_NATIVE_CLI_ACCOUNT_PIN'
export const NATIVE_CODEX_ROUTING_KEY_ENV = 'OPKA_CODEX_ROUTING_KEY'
export const NATIVE_CLI_INITIAL_ASSIGNMENT_ENV = 'ORCA_NATIVE_CLI_INITIAL_ASSIGNMENT'
