import { unlink } from 'node:fs/promises'
import { z } from 'zod'
import type { ProjectTaskAgentSettings } from '../../shared/project-task-agent-settings'
import { PROJECT_TASK_SKILL } from '../../shared/project-task-skill'
import { writePluginFileAtomically } from '../plugins/plugin-atomic-file-write'
import {
  installProjectTaskAgentIntegration,
  TASK_AGENT_SKILL_PATHS
} from './task-agent-integration'
import { isTaskFileMissing, readTaskText, taskFilePath } from './task-file-io'

const SETTINGS_PATH = '.orca/task-agent-settings.json'
const settingsSchema = z.object({ schema: z.literal(1), enabled: z.boolean() }).strict()

export async function readTaskAgentSettings(root: string): Promise<ProjectTaskAgentSettings> {
  const settings = await readTaskText(root, SETTINGS_PATH).catch((error: unknown) => {
    if (isTaskFileMissing(error)) {
      return null
    }
    throw error
  })
  const enabled = settings === null ? true : settingsSchema.parse(JSON.parse(settings)).enabled
  const files = await Promise.all(
    TASK_AGENT_SKILL_PATHS.map(async (path) => {
      const content = await readTaskText(root, path).catch((error: unknown) => {
        if (isTaskFileMissing(error)) {
          return null
        }
        throw error
      })
      const state =
        content === null ? 'missing' : content === PROJECT_TASK_SKILL ? 'installed' : 'customized'
      return { path, state } as const
    })
  )
  const state = files.some((file) => file.state === 'customized')
    ? 'customized'
    : enabled && files.every((file) => file.state === 'installed')
      ? 'enabled'
      : !enabled && files.every((file) => file.state === 'missing')
        ? 'disabled'
        : 'needs-repair'
  return { enabled, state, files }
}

export async function configureTaskAgentSettings(
  root: string,
  action: 'reconcile' | 'enable' | 'disable'
): Promise<ProjectTaskAgentSettings> {
  const current = await readTaskAgentSettings(root)
  if (current.state === 'customized') {
    if (action === 'reconcile') {
      return current
    }
    throw new Error(
      'Custom task instructions were preserved. Review the listed skill files before changing this setting.'
    )
  }
  const enabled = action === 'reconcile' ? current.enabled : action === 'enable'
  if (action === 'reconcile' && current.state === (enabled ? 'enabled' : 'disabled')) {
    return current
  }
  if (enabled) {
    await installProjectTaskAgentIntegration(root)
  }
  await writePluginFileAtomically(
    await taskFilePath(root, SETTINGS_PATH, true),
    `${JSON.stringify({ schema: 1, enabled }, null, 2)}\n`,
    { mode: 0o644 }
  )
  if (!enabled) {
    for (const file of current.files.filter((file) => file.state === 'installed')) {
      const content = await readTaskText(root, file.path)
      if (content !== PROJECT_TASK_SKILL) {
        throw new Error(
          'Task instructions changed during update and were preserved. Recheck board settings.'
        )
      }
      await unlink(await taskFilePath(root, file.path))
    }
  }
  return readTaskAgentSettings(root)
}
