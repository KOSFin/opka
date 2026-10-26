import { writeFile } from 'node:fs/promises'
import { PROJECT_TASK_SKILL } from '../../shared/project-task-skill'
import { isTaskFileMissing, readTaskText, taskFilePath } from './task-file-io'

export const TASK_AGENT_SKILL_PATHS = [
  '.agents/skills/opka-tasks/SKILL.md',
  '.claude/skills/opka-tasks/SKILL.md'
]

export async function installProjectTaskAgentIntegration(root: string) {
  const targets: { relativePath: string; target: string; existing: string | null }[] = []
  for (const relativePath of TASK_AGENT_SKILL_PATHS) {
    const target = await taskFilePath(root, relativePath, true)
    const existing = await readTaskText(root, relativePath).catch((error: unknown) => {
      if (isTaskFileMissing(error)) {
        return null
      }
      throw error
    })
    if (existing !== null && existing !== PROJECT_TASK_SKILL) {
      throw new Error(
        `Existing ${relativePath} was preserved. Review it before enabling this integration.`
      )
    }
    targets.push({ relativePath, target, existing })
  }
  for (const { target, existing, relativePath } of targets) {
    if (existing !== null) {
      continue
    }
    await writeFile(target, PROJECT_TASK_SKILL, { flag: 'wx', mode: 0o644 }).catch(
      async (error: unknown) => {
        if (
          !(error instanceof Error && 'code' in error && error.code === 'EEXIST') ||
          (await readTaskText(root, relativePath)) !== PROJECT_TASK_SKILL
        ) {
          throw error
        }
      }
    )
  }
  return { paths: targets.map((entry) => entry.relativePath) }
}
