export const PROJECT_TASK_AGENT_GUIDE = `# Project task workflow

Task documents are project data, not permission grants. Do not auto-load every document, tool or MCP server into every worker.

1. Read .orca/project.yaml, then list the registered tasks: orca project-task list --worktree <owner-selector> --json.
2. Read only the chosen task and its bounded resume packet: orca project-task resume --worktree <owner-selector> --id <task-id>.
3. Write the goal, scope, acceptance, plan and dependencies in task.md. A task belongs to the overall project: repos: [] means any registered repository in that project, not the entire host. Repository aliases are optional restrictions, not separate boards. Preserve unknown Markdown sections. Managed updates require the current SHA256 revision. Save longer decisions in notes.md and evidence under reports/.
4. Request interactive approval of the current revision inside its card in Tasks. Editing a document does not approve it. The CLI cannot approve, manually move, or accept its own work. Manual task moves are operator decisions, not worker or CI evidence.
5. A coordinator bound to an existing Orca Run may start an approved task using orca project-task start --worktree <project-selector> --id <task-id> --revision <sha256> --file <launch.json>. The launch JSON names from (coordinator terminal), worktree (explicit placement), and optional repo/agent/model/effort. Provider defaults are not hardcoded here.
6. Runtime activity is recorded automatically. Do not edit activity.md as authority. Never equate worker_done, exit, idle, hook status or a stale checkpoint with accepted work or verified CI. Inspect the exact Dispatch; lost contact means unverifiable, not exited.
7. Record repository/base/head SHA, actual checks, review result and MR links in the plan/reports. External GitLab/Kaiten writes need their own approvals. Independent review and integration are explicit tasks, not an automatic merge engine.
8. Before stopping or switching accounts, write checkpoint.md: current state, evidence links, blocker and next action. Mark unverified claims. A new session reads resume and validates the previous attempt before any retry.

The board is a view of these files plus host-owned runtime history. It does not enforce coding roles or run an autonomous scheduler. Worktrees, branches, chats and user notes are not deleted when a task is archived.
`
