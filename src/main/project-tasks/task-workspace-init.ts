import { randomUUID } from 'node:crypto'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { stringify } from 'yaml'
import { PROJECT_TASK_CONFIG_PATH } from '../../shared/project-task-contract'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { PROJECT_TASK_AGENT_GUIDE } from '../../shared/project-task-agent-guide'
import { writePluginFileAtomically } from '../plugins/plugin-atomic-file-write'
import { parseTaskProject } from './task-document'
import { isTaskFileMissing, taskFilePath } from './task-file-io'
import { installProjectTaskAgentIntegration } from './task-agent-integration'

export async function initializeTaskFiles(root: string, content?: string) {
  const project = parseTaskProject(
    content ??
      stringify({
        schema: 1,
        id: `project-${randomUUID()}`,
        repos: { root: '.' },
        sources: [{ id: 'project', path: 'docs/work/tasks' }]
      })
  )
  const config = await taskFilePath(root, PROJECT_TASK_CONFIG_PATH, true)
  if (
    await lstat(config).catch((error: unknown) => {
      if (isTaskFileMissing(error)) {
        return null
      }
      throw error
    })
  ) {
    throw new Error('Project task configuration already exists')
  }
  for (const source of project.sources) {
    await mkdir(dirname(await taskFilePath(root, `${source.path}/.keep`, true)), {
      recursive: true
    })
  }
  for (const detailed of [false, true]) {
    const path = await taskFilePath(
      root,
      `.orca/templates/${detailed ? 'project-task-detailed' : 'project-task'}.md`,
      true
    )
    await writeFile(
      path,
      projectTaskTemplate({ id: 'task-<uuid>', title: '{{title}}', detailed }),
      { flag: 'wx', mode: 0o644 }
    ).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    })
  }
  await installProjectTaskAgentIntegration(root)
  await writePluginFileAtomically(config, stringify(project), { mode: 0o644 })
  const guide = await taskFilePath(root, '.orca/task-workflow.md', true)
  await writeFile(guide, PROJECT_TASK_AGENT_GUIDE, { flag: 'wx', mode: 0o644 }).catch(
    (error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    }
  )
  return project
}
