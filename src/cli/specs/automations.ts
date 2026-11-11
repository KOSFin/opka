import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const AUTOMATION_TARGET_FLAGS = [
  'repo',
  'workspace',
  'project',
  'host',
  'project-host-setup',
  'source-context',
  'workspace-mode',
  'base-branch'
]
const AUTOMATION_SCHEDULE_FLAGS = ['trigger', 'schedule', 'time', 'day', 'timezone']
const AUTOMATION_PRECHECK_FLAGS = ['precheck', 'precheck-timeout']
const AUTOMATION_STATE_FLAGS = [
  'enabled',
  'disabled',
  'missed-run-grace-minutes',
  'reuse-session',
  'fresh-session'
]

export const AUTOMATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['automations', 'command', 'list'],
    summary: 'List command automations on this execution host',
    usage: 'orca automations command list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['automations', 'command', 'show'],
    summary: 'Show a command automation',
    usage: 'orca automations command show <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id']
  },
  {
    path: ['automations', 'command', 'create'],
    summary: 'Create a versioned command automation from a bounded JSON file',
    usage: 'orca automations command create --execution-file <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'execution-file'],
    notes: [
      'The file contains a strict V1 command definition, at most 128 KiB. Unsupported hosts refuse before any effect.'
    ]
  },
  {
    path: ['automations', 'command', 'edit'],
    summary: 'Edit a versioned command automation',
    usage:
      'orca automations command edit <id> --expected-revision <n> --execution-file <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'expected-revision', 'execution-file'],
    positionalArgs: ['id'],
    notes: ['The file contains a strict sparse V1 definition update. Omitted fields are preserved.']
  },
  {
    path: ['automations', 'command', 'remove'],
    destructive: true,
    summary: 'Remove a command automation',
    usage: 'orca automations command remove <id> --expected-revision <n> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'expected-revision'],
    positionalArgs: ['id']
  },
  {
    path: ['automations', 'command', 'run'],
    summary: 'Run a command automation with an explicit replay key',
    usage:
      'orca automations command run <id> --expected-revision <n> --request-key <key> --request-created-at <unix-ms> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'expected-revision', 'request-key', 'request-created-at'],
    positionalArgs: ['id'],
    notes: [
      'Reuse the same key and creation timestamp after a lost reply. A missing V2 host never falls back to an agent automation.'
    ]
  },
  {
    path: ['automations', 'command', 'cancel'],
    summary: 'Request cancellation of an owned command run',
    usage: 'orca automations command cancel <id> --run-id <run-id> --request-key <key> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'run-id', 'request-key'],
    positionalArgs: ['id']
  },
  {
    path: ['automations', 'command', 'runs'],
    summary: 'Read command automation run history and report references',
    usage: 'orca automations command runs <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id']
  },
  {
    path: ['automations', 'list'],
    summary: 'List scheduled Orca automations',
    usage: 'orca automations list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca automations list', 'orca automations list --json']
  },
  {
    path: ['automations', 'show'],
    summary: 'Show one Orca automation',
    usage: 'orca automations show <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['orca automations show 2f9e...', 'orca automations show --id 2f9e... --json']
  },
  {
    path: ['automations', 'create'],
    summary: 'Create a scheduled Orca automation',
    usage:
      'orca automations create --name <name> --trigger <preset|cron|rrule> --prompt <text> --provider <agent> [--precheck <command>] [--repo <selector>|--workspace <selector>|--project <id-or-name> [--host <host>]|--project-host-setup <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'name',
      'prompt',
      'provider',
      'extra-agent-args',
      ...AUTOMATION_PRECHECK_FLAGS,
      ...AUTOMATION_TARGET_FLAGS,
      ...AUTOMATION_SCHEDULE_FLAGS,
      ...AUTOMATION_STATE_FLAGS
    ],
    notes: [
      'Trigger accepts hourly, daily, weekdays, weekly, a 5-field cron expression, or an RRULE string.',
      'When --repo is omitted, the CLI uses the enclosing Orca worktree when one can be resolved from cwd.',
      'Use --project, or --project-host-setup, to run on a specific project host setup. --project takes the project id or the display name from `orca project list`, and --host is only needed when the project is set up on more than one host.',
      '--host takes local, ssh:<target-id>, runtime:<environment-id>, or the bare host name `orca host list` prints for any of them.',
      'Use --source-context with a JSON TaskSourceContext when task/provider data should come from a specific host/account; pass null on edit to clear it.',
      'Use --workspace to run in an existing worktree; otherwise the automation creates a new worktree per run.',
      'Use --precheck to run a bounded command before scheduled runs; exit code 0 continues, anything else records a skipped run.',
      'Use --reuse-session only with existing-workspace automations to submit later runs to the previous live automation session when it is still available. Use --fresh-session to disable reuse.',
      'Use --extra-agent-args="--model opus --effort high" to add arguments after the host\'s default agent Arguments on each fresh run. Only model, effort, and a few safe options are accepted (Claude, Codex, CodeBuddy, Cursor, Grok, OMP); extras cannot be combined with --reuse-session. On edit, --extra-agent-args= clears them.'
    ],
    examples: [
      'orca automations create --name "Daily review" --trigger daily --prompt "Review open changes" --provider codex',
      'orca automations create --name "Weekday triage" --trigger "0 9 * * 1-5" --prompt "Triage issues" --provider claude --repo my-repo',
      'orca automations create --name "PR review" --trigger hourly --precheck "gh pr list --json number -q .[0].number" --prompt "Review requested PRs" --provider codex',
      'orca automations create --name "Docs pass" --trigger daily --prompt "Tidy the docs" --provider claude --extra-agent-args="--model opus --effort high --add-dir docs"'
    ]
  },
  {
    path: ['automations', 'edit'],
    summary: 'Edit an Orca automation',
    usage: 'orca automations edit <id> [--name <name>] [--trigger <preset|cron|rrule>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'id',
      'name',
      'prompt',
      'provider',
      'extra-agent-args',
      ...AUTOMATION_PRECHECK_FLAGS,
      ...AUTOMATION_TARGET_FLAGS,
      ...AUTOMATION_SCHEDULE_FLAGS,
      ...AUTOMATION_STATE_FLAGS
    ],
    positionalArgs: ['id'],
    examples: [
      'orca automations edit 2f9e... --disabled',
      'orca automations edit --id 2f9e... --trigger "30 * * * *" --json',
      'orca automations edit 2f9e... --extra-agent-args='
    ]
  },
  {
    path: ['automations', 'remove'],
    destructive: true,
    summary: 'Remove an Orca automation and its run history',
    usage: 'orca automations remove <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['orca automations remove 2f9e...', 'orca automations remove --id 2f9e... --json']
  },
  {
    path: ['automations', 'run'],
    summary: 'Run an Orca automation now',
    usage: 'orca automations run <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [
      'Use the full automation UUID from orca automations list; shortened prefixes are not accepted.',
      'A queued or dispatching run has been accepted but may not have a workspace or terminal yet. Use orca automations runs --id <automation-id> to follow its progress.'
    ],
    examples: [
      'orca automations run 497bafa9-5a97-4f85-9e48-2b211b8f31fa',
      'orca automations run --id 497bafa9-5a97-4f85-9e48-2b211b8f31fa --json'
    ]
  },
  {
    path: ['automations', 'runs'],
    summary: 'List automation run history',
    usage:
      'orca automations runs [--id <automation-id>] [--limit <n>] [--cursor <cursor>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'limit', 'cursor'],
    notes: [
      'Without --limit or --cursor, reads the whole history in pages, so a large history from a paired server still fits in its replies.',
      'With --limit or --cursor, prints one page (newest first, at most 100 runs) and its nextCursor; pass that as --cursor for the next page.'
    ],
    examples: [
      'orca automations runs',
      'orca automations runs --id 2f9e... --json',
      'orca automations runs --limit 20 --json'
    ]
  }
]
