import { resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { isDirectInvocation } from './script-entry-detection.mjs'

const root = resolve(import.meta.dirname, '../..')
export const FORK_TEST_FILTERS = [
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
  'config/scripts/e2e-cli-artifact-capability.test.mjs',
  'config/scripts/electron-builder-config.test.mjs',
  'config/scripts/verify-skills-cli-runtime.test.mjs',
  'tests/tools/project-task-'
]

function run(program, args) {
  const result = runProcessSync({
    program,
    args,
    cwd: root,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    process.exit(result.code ?? 1)
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  run('pnpm', ['test', ...FORK_TEST_FILTERS, '--maxWorkers=2'])
  run(process.execPath, [
    '--test',
    'config/scripts/fork-acceptance-fixture.test.mjs',
    'config/scripts/fork-acceptance-remote-config.test.mjs'
  ])
}
