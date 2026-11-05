import { nativeCliLaunchArguments } from '../../src/shared/native-cli-launch-arguments.ts'
import { NATIVE_CODEX_ROUTING_KEY_ENV } from '../../src/shared/native-cli-account-launch.ts'
export function codexNativeProbeArguments({
  execQuota,
  toolQuota,
  newConversation,
  encryptedModel,
  compactMode,
  approval,
  approvalCapture,
  cancelMode,
  resumeMode,
  builtinOpenai,
  routingPlan,
  vision,
  workspace,
  transcript,
  codex,
  imagePath
}) {
  return execQuota
    ? nativeProbeManagedArguments(
        [
          ...(routingPlan ? [] : ['--no-daemon']),
          'exec',
          '--json',
          '--skip-git-repo-check',
          '-C',
          workspace,
          '-m',
          'probe-a',
          '-s',
          toolQuota ? 'danger-full-access' : 'read-only',
          'Return SYNTHETIC_B_MARKER.'
        ],
        routingPlan ?? {}
      )
    : [
        'config/scripts/capture-agent-pty-transcript.mjs',
        '--out',
        transcript,
        '--duration',
        approvalCapture ? '9' : resumeMode && !builtinOpenai ? '7' : cancelMode ? '20' : '16',
        '--cols',
        '120',
        '--rows',
        '40',
        '--send',
        '2000:Return SYNTHETIC_A_MARKER.',
        '--send',
        '2600:\r',
        ...(newConversation || encryptedModel || compactMode
          ? [
              '--send',
              newConversation
                ? '6000:/new'
                : compactMode
                  ? '6000:/compact'
                  : '6000:/model gpt-6.1-terra',
              '--send',
              '6500:\r'
            ]
          : []),
        ...(approval && !approvalCapture ? ['--send', '6000:\r'] : []),
        ...(cancelMode ? ['--send', '6000:\u001b'] : []),
        ...(approvalCapture || (resumeMode && !builtinOpenai)
          ? []
          : [
              '--send',
              '8500:Retain the previous exchange and return SYNTHETIC_B_MARKER.',
              '--send',
              '9100:\r'
            ]),
        ...(cancelMode
          ? [
              '--send',
              '14000:Return SYNTHETIC_B_MARKER after the completed exchange.',
              '--send',
              '14600:\r'
            ]
          : []),
        '--',
        codex,
        ...nativeProbeManagedArguments(
          [
            ...(routingPlan ? [] : ['--no-daemon']),
            '--no-alt-screen',
            ...(vision ? ['-i', imagePath] : []),
            '-C',
            workspace,
            '-a',
            approval ? 'on-request' : 'never',
            '-s',
            'read-only'
          ],
          routingPlan ?? {}
        )
      ]
}

export function readNativeProbeModes(argv) {
  const builtinOpenai = argv.includes('--builtin-openai')
  const resumeMode = argv.includes('--resume')
  const cancelMode = argv.includes('--cancel')
  const approvalCapture = argv.includes('--approval-capture')
  const approval = approvalCapture || argv.includes('--approval')
  const catalogPath = argv.includes('--catalog') ? argv[argv.indexOf('--catalog') + 1] : null
  const compactMode = argv.includes('--compact')
  const encryptedModel = argv.includes('--encrypted-model')
  const toolQuota = argv.includes('--tool-quota')
  const execQuota = argv.includes('--exec-quota') || toolQuota
  const newConversation = argv.includes('--new-conversation')
  const vision = argv.includes('--vision')
  if (
    [
      execQuota,
      newConversation,
      vision,
      encryptedModel,
      compactMode,
      approval,
      cancelMode,
      resumeMode
    ].filter(Boolean).length > 1
  ) {
    throw new Error('Choose one probe scenario')
  }
  return {
    builtinOpenai,
    resumeMode,
    cancelMode,
    approvalCapture,
    approval,
    catalogPath,
    compactMode,
    encryptedModel,
    toolQuota,
    execQuota,
    newConversation,
    vision
  }
}

export function nativeProbeScope(argv) {
  const {
    execQuota,
    toolQuota,
    newConversation,
    resumeMode,
    cancelMode,
    approval,
    approvalCapture,
    encryptedModel,
    compactMode,
    vision
  } = readNativeProbeModes(argv)
  return {
    scenario: execQuota
      ? toolQuota
        ? 'external-exec-tool-quota'
        : 'external-exec-quota'
      : newConversation
        ? 'new-conversation'
        : resumeMode
          ? 'resume-provider-namespace'
          : cancelMode
            ? 'cancel'
            : approval
              ? approvalCapture
                ? 'approval-capture'
                : 'approval'
              : encryptedModel
                ? 'encrypted-model'
                : compactMode
                  ? 'compact'
                  : vision
                    ? 'vision'
                    : 'text',
    ordinaryPty: !execQuota,
    noDaemon: true,
    nativeSandbox: toolQuota ? 'danger-full-access-synthetic-fixed-printf-only' : 'read-only',
    brokeredNativeLaunchExercised: false,
    realProviderAcceptanceProven: false,
    injectedCanonicalBoundary: false
  }
}

export function nativeProbeManagedArguments(args, plan = {}) {
  const result = nativeCliLaunchArguments('codex', args, plan)
  if (plan.env?.[NATIVE_CODEX_ROUTING_KEY_ENV] && !result.includes('--no-daemon')) {
    throw new Error('Production routed arguments did not disable the shared native daemon')
  }
  return result
}
