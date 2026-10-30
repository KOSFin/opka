import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { prepareCodexAccountRestartResume } from '../codex/codex-legacy-session-resume'
import { resolveTrustedCodexSessionResumeHome } from '../codex/codex-session-resume-home'

async function transcriptInside(root: string, transcript: string): Promise<string> {
  const [directory, file] = await Promise.all([realpath(root), realpath(transcript)])
  if (!relativePathInsideRoot(directory, file) || !(await stat(file)).isFile()) {
    throw new Error('The conversation is outside its owning account history')
  }
  return file
}

/** Both homes must already have passed the owning host's account validation. */
export async function prepareAccountPoolResume(args: {
  provider: 'claude' | 'codex'
  sourceHome: string
  targetHome: string
  providerSession: AgentProviderSessionMetadata
}): Promise<AgentProviderSessionMetadata> {
  const transcript = args.providerSession.transcriptPath
  if (!transcript || args.providerSession.key !== 'session_id') {
    throw new Error('An exact conversation transcript is required before changing accounts')
  }
  if (args.provider === 'claude') {
    const source = await transcriptInside(join(args.sourceHome, 'projects'), transcript)
    const sharedRoot = await realpath(join(args.targetHome, 'projects'))
    const relative = relativePathInsideRoot(sharedRoot, source)
    if (!relative) {
      throw new Error(
        'Claude history is not shared with the target account; the original chat remains unchanged'
      )
    }
    return { ...args.providerSession, transcriptPath: join(args.targetHome, 'projects', relative) }
  }
  await transcriptInside(join(args.sourceHome, 'sessions'), transcript)
  if (
    !resolveTrustedCodexSessionResumeHome({
      transcriptPath: transcript,
      trustedCodexHomes: [args.sourceHome]
    })
  ) {
    throw new Error('The Codex rollout has no verified source account')
  }
  const relative = relativePathInsideRoot(join(args.sourceHome, 'sessions'), transcript)
  if (!relative) {
    throw new Error('The Codex rollout has no verified relative path')
  }
  await prepareCodexAccountRestartResume({
    sourceHome: args.sourceHome,
    targetHome: args.targetHome,
    transcriptPath: transcript,
    systemCodexHomePath: getSystemCodexHomePath()
  })
  const target = join(args.targetHome, 'sessions', relative)
  await transcriptInside(join(args.targetHome, 'sessions'), target)
  return { ...args.providerSession, transcriptPath: target }
}
