import { readdir, lstat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { taskFilePath, readTaskText, isTaskFileMissing } from './task-file-io'

export async function taskDocuments(root: string, taskPath: string, selectedPath?: string) {
  const directory = dirname(taskPath).replaceAll('\\', '/')
  const paths: string[] = []
  for (const name of ['checkpoint.md', 'notes.md']) {
    const path = `${directory}/${name}`
    try {
      if ((await lstat(await taskFilePath(root, path))).isFile()) {
        paths.push(path)
      }
    } catch (error) {
      if (!isTaskFileMissing(error)) {
        throw error
      }
    }
  }
  try {
    const reports = await taskFilePath(root, `${directory}/reports`)
    const entries = await readdir(reports, { withFileTypes: true })
    for (const entry of entries
      .filter((item) => item.isFile() && item.name.endsWith('.md'))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 100)) {
      paths.push(`${directory}/reports/${entry.name}`)
    }
  } catch (error) {
    if (!isTaskFileMissing(error)) {
      throw error
    }
  }
  if (selectedPath && !paths.includes(selectedPath)) {
    throw new Error('Choose a saved document belonging to this task')
  }
  return {
    paths,
    ...(selectedPath ? { path: selectedPath, content: await readTaskText(root, selectedPath) } : {})
  }
}
