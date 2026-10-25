import { GLOBAL_FLAGS, type CommandSpec } from '../args'

const common = [...GLOBAL_FLAGS, 'worktree']
export const PROJECT_TASK_COMMAND_SPECS: CommandSpec[] = [
  ...(['claim', 'progress', 'complete'] as const).map((operation) => ({
    path: ['project-task', operation],
    summary:
      operation === 'claim'
        ? 'Take an approved task in this existing agent chat (no worker spawned)'
        : operation === 'complete'
          ? 'Save the result and request review, not acceptance'
          : 'Save a checkpoint and optional blocker',
    usage: `orca project-task ${operation} --id <id> --revision <sha256>${operation === 'claim' ? '' : ' --attempt <id> (--checkpoint <text> | --checkpoint-file <path>)'}${operation === 'complete' ? ' --file <report.md>' : operation === 'progress' ? ' [--release]' : ''} [--worktree <selector>] [--json]`,
    allowedFlags: [
      ...common,
      'id',
      'revision',
      ...(operation === 'claim' ? [] : ['attempt', 'checkpoint', 'checkpoint-file', 'blocker']),
      ...(operation === 'progress' ? ['release'] : []),
      ...(operation === 'complete' ? ['file'] : [])
    ]
  })),
  {
    path: ['project-task', 'documents'],
    summary: 'List saved task notes, checkpoints and reports, or read one by project-relative path',
    usage: 'orca project-task documents --id <id> [--path <path>] [--worktree <selector>] [--json]',
    allowedFlags: [...common, 'id', 'path']
  },
  ...(['board', 'workflow', 'resume', 'start'] as const).map((operation) => ({
    path: ['project-task', operation],
    summary:
      operation === 'start'
        ? 'Start one approved project task using an existing coordinator Run'
        : 'Read host-owned project task workflow',
    usage: `orca project-task ${operation} --worktree <selector>${operation === 'board' ? ' [--offset <n>] [--limit <n>]' : ' --id <id>'}${operation === 'start' ? ' --revision <sha256> --file <launch.json>' : ''} [--json]`,
    allowedFlags:
      operation === 'board'
        ? [...common, 'offset', 'limit']
        : [...common, 'id', ...(operation === 'start' ? ['revision', 'file'] : [])]
  })),
  {
    path: ['project-task', 'init'],
    summary: 'Register file-backed tasks in a workspace (no workers started)',
    usage: 'orca project-task init --worktree <selector> [--file <project.yaml>] [--json]',
    allowedFlags: [...common, 'file']
  },
  {
    path: ['project-task', 'list'],
    summary: 'List file-backed tasks and validation errors',
    usage: 'orca project-task list --worktree <selector> [--offset <n>] [--limit <n>] [--json]',
    allowedFlags: [...common, 'offset', 'limit']
  },
  {
    path: ['project-task', 'show'],
    summary: 'Read a task document and its revision',
    usage: 'orca project-task show --worktree <selector> --id <id> [--json]',
    allowedFlags: [...common, 'id']
  },
  {
    path: ['project-task', 'context'],
    summary: 'Read bounded task context for a new agent session',
    usage: 'orca project-task context --worktree <selector> --id <id> [--json]',
    allowedFlags: [...common, 'id']
  },
  {
    path: ['project-task', 'create'],
    summary: 'Create a task document, not an execution',
    usage:
      'orca project-task create --worktree <selector> --slug <name> [--source <id>] [--title <text>] [--file <task.md>] [--detailed] [--json]',
    allowedFlags: [...common, 'slug', 'source', 'title', 'file', 'detailed']
  },
  {
    path: ['project-task', 'update'],
    summary: 'Update a task only if its revision is unchanged',
    usage:
      'orca project-task update --worktree <selector> --id <id> --revision <sha256> --file <task.md> [--json]',
    allowedFlags: [...common, 'id', 'revision', 'file']
  }
]
