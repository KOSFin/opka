import { resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'

const root = resolve(import.meta.dirname, '../..')
const suites = [
  'src/main/project-groups/',
  'src/main/project-tasks/',
  'src/main/runtime/project-task-workspaces.test.ts',
  'src/main/agent-hooks/server-five-projects.test.ts',
  'src/main/cli/',
  'src/shared/project-task-',
  'src/shared/sidebar-list/',
  'src/renderer/src/components/task-page/project-task-',
  'src/renderer/src/components/task-page/use-task-project-',
  'src/renderer/src/components/right-sidebar/folder-project-repositories.test.ts',
  'src/renderer/src/components/right-sidebar/use-source-control-',
  'src/renderer/src/components/right-sidebar/source-control/panel/source-control-view-memory.test.tsx',
  'src/renderer/src/components/right-sidebar/source-control/sync/use-git-history-view.test.tsx',
  'src/renderer/src/components/right-sidebar/source-control/listing/reveal-source-control-workspace.test.ts',
  'src/renderer/src/components/sidebar/worktree-list/rows/ProjectTreeTitle.test.tsx',
  'src/renderer/src/components/sidebar/worktree-list/rows/open-project-folder.test.ts',
  'src/renderer/src/components/sidebar/worktree-list-groups-nested-project-groups.test.ts',
  'src/renderer/src/components/sidebar/host-section-',
  'src/renderer/src/components/sidebar/repo-folder-section.test.ts',
  'src/renderer/src/components/sidebar/SidebarToolbar.test.tsx',
  'src/renderer/src/components/settings/CliSection.install-failure.test.tsx',
  'src/renderer/src/components/floating-pane/',
  'src/renderer/src/store/slices/ui-page-navigation.test.ts',
  'src/renderer/src/store/folder-workspaces/folder-path-status-ownership.test.ts',
  'config/scripts/swiftpm-libraries.test.mjs',
  'config/scripts/orcad-prebuild-node-gyp.test.mjs',
  'config/scripts/packaged-cli-dependency-copy.test.mjs',
  'config/scripts/check-root-directory-entries.test.mjs',
  'config/scripts/fork-ci-contract.test.mjs',
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

run('pnpm', ['test', ...suites, '--maxWorkers=2'])
run(process.execPath, [
  '--test',
  'config/scripts/fork-acceptance-fixture.test.mjs',
  'config/scripts/fork-acceptance-remote-config.test.mjs'
])
