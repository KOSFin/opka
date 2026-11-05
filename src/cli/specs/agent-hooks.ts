import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_HOOK_COMMAND_SPECS: CommandSpec[] = [
  ...(['status', 'install', 'uninstall'] as const).map((action) => ({
    path: ['agent', 'native-shell', action],
    summary: `${action === 'status' ? 'Inspect' : action === 'install' ? 'Install' : 'Remove'} this host's native account command integration`,
    usage: `orca agent native-shell ${action} [--json]`,
    allowedFlags: [...GLOBAL_FLAGS]
  })),
  {
    path: ['agent', 'native-attach'],
    argumentMode: 'passthrough',
    hidden: true,
    summary: 'Reattach a native CLI terminal retained on this execution host',
    usage: 'orca agent native-attach <launch id>',
    allowedFlags: []
  },
  {
    path: ['agent', 'native-exec'],
    argumentMode: 'passthrough',
    hidden: true,
    summary: 'Run a native agent using this host account policy',
    usage: 'orca agent native-exec <claude|codex> <absolute executable> [native args...]',
    allowedFlags: []
  },
  {
    path: ['agent', 'hooks', 'prepare-codex'],
    summary: "Prepare a WSL pane's Orca-managed Codex home before a shell launch",
    usage: 'orca agent hooks prepare-codex',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show whether Orca-managed agent status hooks are enabled',
    usage: 'orca agent hooks status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca agent hooks status', 'orca agent hooks status --json']
  },
  {
    path: ['agent', 'hooks', 'off'],
    summary: 'Disable Orca-managed agent status hooks and remove local hook entries',
    usage: 'orca agent hooks off [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca agent hooks off']
  },
  {
    path: ['agent', 'hooks', 'on'],
    summary: 'Enable Orca-managed agent status hooks',
    usage: 'orca agent hooks on [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca agent hooks on']
  }
]
