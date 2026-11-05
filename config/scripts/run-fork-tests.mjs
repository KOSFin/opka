import { resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { isDirectInvocation } from './script-entry-detection.mjs'
import { parseForkSelectionArgs, prepareForkTestSelection } from './fork-test-selection.mjs'

const root = resolve(import.meta.dirname, '../..')
export const FORK_TEST_FILTERS = [
  'src/shared/usage-account-provenance.test.ts',
  'src/shared/status-bar-account-pins.test.ts',
  'src/shared/agent-feature-install-commands.test.ts',
  'src/cli/skills.test.ts',
  'src/main/rate-limits/service-account-provenance.test.ts',
  'src/main/rate-limits/service-account-target-selection.test.ts',
  'src/main/rate-limits/service-refresh-orchestration.test.ts',
  'src/main/rate-limits/service-live-claude-usage.test.ts',
  'src/main/rate-limits/service-inactive-account-previews.test.ts',
  'src/main/codex-accounts/runtime-home-per-account-homes.test.ts',
  'src/main/codex-accounts/runtime-home-wsl-managed-accounts.test.ts',
  'src/main/codex-accounts/runtime-home-wsl-system-default.test.ts',
  'src/main/gitlab/work-item-details.test.ts',
  'src/main/persistence-ui-state.test.ts',
  'src/renderer/src/components/settings/AccountPoolSection.test.tsx',
  'src/renderer/src/components/settings/AccountsPane',
  'src/renderer/src/components/feature-wall/skill-owner-computer-permissions.test.ts',
  'src/renderer/src/components/status-bar/Usage',
  'src/renderer/src/components/status-bar/usage-account-',
  'src/renderer/src/components/status-bar/usage-pinned-account-',
  'src/renderer/src/components/status-bar/use-usage-account-pools.test.tsx',
  'src/renderer/src/components/status-bar/use-owner-usage-rate-limits.test.tsx',
  'src/renderer/src/components/status-bar/use-codex-switcher-runtime-owner.test.tsx',
  'src/renderer/src/components/status-bar/codex-status-sign-in.test.tsx',
  'src/renderer/src/components/status-bar/claude-status-sign-in.test.tsx',
  'src/renderer/src/store/slices/ui-hydration-workspace-preferences.test.ts',
  'src/shared/account-pool-',
  'src/main/runtime/account-pool-',
  'src/main/runtime/pty-account-pool-',
  'src/main/runtime/native-account-pool-',
  'src/main/runtime/agent-session-account-home-pin.test.ts',
  'src/main/runtime/orchestration/account-pool-admission.test.ts',
  'src/main/runtime/orchestration/db/account-pool-assignments.test.ts',
  'src/main/runtime/rpc/methods/account-pools.test.ts',
  'src/main/ipc/pty/account-pool-launch.test.ts',
  'src/main/ipc/pty-pool-persisted-pane-resume.test.ts',
  'src/main/claude-accounts/pinned-account-launch.test.ts',
  'src/main/native-chat/agent-session-wire/structured-account-',
  'src/main/updater',
  'src/main/host/electron-repo-icon-fetch.test.ts',
  'src/preload/updater-manual-installer.test.ts',
  'src/main/codex/codex-hook-command-form.test.ts',
  'src/main/codex/codex-hook-reconcile.test.ts',
  'src/main/startup/codex-hook-startup-wiring.test.ts',
  'src/main/codex/codex-real-home-hook-entries.test.ts',
  'src/main/codex/codex-interrupt-hook-trust.test.ts',
  'src/shared/pairing.test.ts',
  'src/renderer/src/components/skills/skill-share-link.test.ts',
  'src/main/worktree-history-file-path.test.ts',
  'src/main/macos-press-and-hold-default.test.ts',
  'src/renderer/src/components/maintenance/update-card/MacBetaUpdateContent.test.tsx',
  'src/shared/release-channel.test.ts',
  'src/shared/local-build-compatibility.test.ts',
  'src/main/startup/configure-process.test.ts',
  'src/main/startup/dev-instance-identity.test.ts',
  'src/main/orcad/orcad-app-paths.test.ts',
  'src/main/orcad/orcad-push-startup.test.ts',
  'src/cli/runtime/launch-user-data-path.test.ts',
  'src/main/managed-server/host-state/orcad-machine-home.test.ts',
  'src/main/managed-server/install/remote-install-model.test.ts',
  'src/main/agent-hooks/managed-hook-install-lock.test.ts',
  'src/main/agent-hooks/installer-utils.test.ts',
  'src/main/claude/post-compact-hook-command.test.ts',
  'src/main/opencode/hook-service-startup-refresh.test.ts',
  'src/main/opencode/opencode-status-plugin-startup-refresh.test.ts',
  'config/scripts/opka-release-assets.test.mjs',
  'config/scripts/opka-packaged-launcher.test.mjs',
  'src/main/project-groups/',
  'src/main/project-tasks/',
  'src/main/persistence-folder-scan-project-groups.test.ts',
  'src/main/runtime/project-task-workspaces.test.ts',
  'src/main/runtime/project-task-session.test.ts',
  'src/main/runtime/project-task-target.test.ts',
  'src/main/runtime/project-task-terminal-caller.test.ts',
  'src/main/runtime/project-task-terminal-proof.test.ts',
  'src/cli/runtime/terminal-task-caller-envelope.test.ts',
  'src/main/runtime/orchestration-compatibility-authority.test.ts',
  'src/main/runtime/structured-worker-hook-attestation.test.ts',
  'src/cli/handlers/project-task.test.ts',
  'src/cli/runtime-client.test.ts',
  'tests/e2e/helpers/fork-task-approvals.unit.test.ts',
  'tests/e2e/helpers/fork-codex-startup.unit.test.ts',
  'tests/e2e/helpers/fork-codex-read-boundary.unit.test.ts',
  'tests/e2e/helpers/fork-installer-probe.unit.test.ts',
  'src/main/runtime/runtime-nested-repo-import-host-twin.test.ts',
  'src/main/ssh/orcad-runtime-maintenance.test.ts',
  'src/main/agent-hooks/server-five-projects.test.ts',
  'src/main/agent-hooks/server-account-pool-rotation-boundary.test.ts',
  'src/main/cli/',
  'src/main/pty/codex-shell-no-daemon.test.ts',
  'src/main/pty/codex-shell-launch-preflight.test.ts',
  'src/main/shell-wrapper-generated-file-snapshot.test.ts',
  'src/main/shell-wrapper-content-address.test.ts',
  'src/main/daemon/daemon-foreground-confirmation-protocol.test.ts',
  'src/main/daemon/pty-subprocess-env-inheritance.test.ts',
  'src/main/daemon/macos-daemon-launchd.test.ts',
  'config/scripts/daemon-protocol-facts.test.mjs',
  'config/scripts/verify-packaged-daemon-entry.test.mjs',
  'src/shared/project-task-',
  'src/shared/sidebar-list/',
  'src/renderer/src/components/task-page/project-task-',
  'src/renderer/src/components/task-page/use-task-project-',
  'src/renderer/src/components/repo/NestedRepoChecklist.test.tsx',
  'src/renderer/src/components/right-sidebar/right-sidebar-activity-visibility.test.ts',
  'src/renderer/src/components/right-sidebar/folder-project-repositories.test.ts',
  'src/renderer/src/components/right-sidebar/use-source-control-',
  'src/renderer/src/components/right-sidebar/source-control/panel/source-control-view-memory.test.tsx',
  'src/renderer/src/components/right-sidebar/source-control/sync/use-git-history-view.test.tsx',
  'src/renderer/src/components/right-sidebar/source-control/listing/reveal-source-control-workspace.test.ts',
  'src/renderer/src/components/sidebar/worktree-list/rows/ProjectTreeTitle.test.tsx',
  'src/renderer/src/components/sidebar/worktree-list/rows/ProjectChatButton.test.tsx',
  'src/renderer/src/components/sidebar/worktree-list/rows/open-project-folder.test.ts',
  'src/renderer/src/components/sidebar/worktree-list-groups-nested-project-groups.test.ts',
  'src/renderer/src/components/sidebar/host-section-',
  'src/renderer/src/components/sidebar/repo-folder-section.test.ts',
  'src/renderer/src/components/sidebar/SidebarToolbar.test.tsx',
  'src/renderer/src/components/sidebar/WorktreeCard.quick-actions.test.tsx',
  'src/renderer/src/components/sidebar/WorktreeList.folder-workspace-rows.test.ts',
  'src/renderer/src/components/settings/CliSection.install-failure.test.tsx',
  'src/renderer/src/components/floating-terminal/',
  'src/renderer/src/store/slices/ui-hydration-view-layout.test.ts',
  'src/renderer/src/store/slices/ui-page-navigation.test.ts',
  'src/renderer/src/store/folder-workspaces/folder-path-status-ownership.test.ts',
  'config/scripts/swiftpm-libraries.test.mjs',
  'config/scripts/orcad-prebuild-node-gyp.test.mjs',
  'config/scripts/packaged-cli-dependency-copy.test.mjs',
  'config/scripts/check-root-directory-entries.test.mjs',
  'config/scripts/fork-ci-contract.test.mjs',
  'config/scripts/fork-test-',
  'config/scripts/ci-unit-dependency-graph.test.mjs',
  'config/scripts/workspace-source-exports.test.mjs',
  'config/scripts/ci-unit-selection.test.mjs',
  'config/scripts/opka-ci-',
  'config/scripts/opka-verify-tested-android.test.mjs',
  'config/scripts/opka-release-qualification.test.mjs',
  'config/scripts/e2e-cli-artifact-capability.test.mjs',
  'config/scripts/electron-builder-config.test.mjs',
  'config/scripts/verify-skills-cli-runtime.test.mjs',
  'tests/tools/project-task-'
]

export const MOBILE_FORK_TEST_FILTERS = [
  'mobile/src/diagnostics/connection-diagnostics-analysis.test.ts',
  'mobile/src/diagnostics/connection-diagnostics-relay-dial.test.ts',
  'mobile/src/mobile-web-shell/bridge/page-back-consumers.test.ts',
  'mobile/src/mobile-web-shell/bridge/bridge-back-round-trip.test.ts',
  'mobile/src/accounts/',
  'mobile/src/tasks/',
  'mobile/src/worktree/',
  'mobile/src/cache/',
  'mobile/src/notifications/',
  'mobile/src/app-update/',
  'mobile/src/home/MobileHomeEmptyState.test.tsx',
  'mobile/src/transport/host-store',
  'mobile/src/components/accounts-snapshot.test.ts',
  'mobile/src/components/account-usage-state.test.ts',
  'mobile/src/components/provider-account-usage.test.ts',
  'mobile/src/components/MobileSectionReveal.test.tsx',
  'mobile/src/components/bottom-drawer-back-while-hiding.test.tsx',
  'mobile/src/components/use-new-workspace-repositories.test.ts',
  'mobile/src/host-screen/host-list-settings-sync.test.ts',
  'mobile/src/host-screen/host-server-workspaces-wiring.test.ts',
  'mobile/src/host-screen/host-sidebar-feed-sections.test.ts',
  'mobile/src/host-screen/host-ssh-health-badge-wiring.test.ts',
  'mobile/src/host-screen/host-view-changes-reconnect.test.ts',
  'mobile/src/host-screen/use-host-project-sections.test.tsx',
  'mobile/src/settings/native-notification-delivery-settings.test.tsx',
  'mobile/src/settings/notification-display-test.test.tsx',
  'mobile/src/settings/settings-screen-state.test.tsx',
  'mobile/src/settings/voice-settings-poller-refresh.test.tsx',
  'mobile/src/session/MobileNativeChatTurnStatus.test.ts',
  'mobile/scripts/opka-app-config.test.ts'
]

export const MOBILE_RENDER_TEST_FILTERS = [
  'config/scripts/mobile-web-app-project-tasks-render.test.mjs',
  'config/scripts/mobile-web-app-stack-transition-render.test.mjs'
]

function run(program, args, environment = {}) {
  const result = runProcessSync({
    program,
    args,
    cwd: root,
    env: { ...process.env, ...environment, ORCA_BACKGROUND_LAUNCH: '1' },
    stdio: 'inherit',
    timeoutMs: null
  })
  return result.code === 0
}

export const NODE_FORK_TESTS = [
  'config/scripts/fork-acceptance-fixture.test.mjs',
  'config/scripts/fork-acceptance-remote-config.test.mjs'
]

export function runForkTestPlan(plan, execute = run) {
  const { lanes } = plan
  const results = []
  const prepared =
    (!lanes.root.length && !lanes.node.length) ||
    (execute('pnpm', ['run', 'build:packages']) &&
      execute(process.execPath, ['config/scripts/ensure-native-runtime.mjs', '--runtime=node']))
  results.push(prepared)
  for (const lane of ['root', 'mobile', 'render']) {
    if (!lanes[lane].length || (lane === 'root' && !prepared)) {
      continue
    }
    results.push(
      execute(
        process.execPath,
        [
          'node_modules/vitest/vitest.mjs',
          'run',
          '--config',
          'config/vitest.fork-selected.config.mjs',
          '--maxWorkers=1'
        ],
        { OPKA_FORK_TEST_LANE: lane }
      )
    )
  }
  results.push(
    execute(process.execPath, [
      '--test',
      '--test-concurrency=1',
      ...new Set([...lanes.node, ...NODE_FORK_TESTS])
    ])
  )
  return results.every(Boolean)
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const request = parseForkSelectionArgs(process.argv.slice(2))
  const plan = prepareForkTestSelection(request, root, [
    ...FORK_TEST_FILTERS,
    ...MOBILE_FORK_TEST_FILTERS,
    ...MOBILE_RENDER_TEST_FILTERS
  ])
  console.log(`Fork test selection: ${plan.reason}; ${plan.files.length} files`)
  process.exitCode = runForkTestPlan(plan) ? 0 : 1
}
