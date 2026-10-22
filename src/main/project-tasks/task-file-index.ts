import { opendir } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import type {
  ProjectTaskDiagnostic,
  ProjectTaskEntry,
  ProjectTaskSnapshot,
  TaskProject
} from '../../shared/project-task-contract'
import { PROJECT_TASK_MAX_COUNT } from '../../shared/project-task-contract'
import { parseProjectTask, taskRevision } from './task-document'
import { isTaskFileMissing, readTaskText, taskFilePath } from './task-file-io'
import { validateTaskGraph } from './task-graph'

const MAX_INDEX_BYTES = 8 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 10_000
const SKIP = new Set(['.git', 'node_modules', 'reports'])

export class TaskFileIndex {
  private readonly entries = new Map<string, ProjectTaskEntry>()
  private readonly errors = new Map<string, ProjectTaskDiagnostic>()
  private readonly dirty = new Set<string>()
  private rescan = true
  private retainedBytes = 0
  parseCount = 0

  constructor(
    private readonly root: string,
    readonly project: TaskProject
  ) {}

  invalidate(paths: string[] | null): void {
    if (paths === null || paths.length > 200) {
      this.rescan = true
      this.dirty.clear()
      return
    }
    for (const path of paths) {
      const local = relative(this.root, path).split(sep).join('/')
      if (local.endsWith('/task.md')) {
        this.dirty.add(local)
        if (this.dirty.size > 200) {
          this.rescan = true
          this.dirty.clear()
          return
        }
      } else if (!/\.[^/]+$/.test(local)) {
        this.rescan = true
      }
    }
  }

  async snapshot(): Promise<ProjectTaskSnapshot> {
    const paths = [...this.dirty]
    this.dirty.clear()
    if (this.rescan) {
      this.rescan = false
      const previous = new Map(this.entries)
      this.entries.clear()
      this.retainedBytes = 0
      this.errors.clear()
      try {
        for (const source of this.project.sources) {
          await this.scan(source, previous)
        }
      } catch (error) {
        this.rescan = true
        throw error
      }
    } else {
      for (const path of paths) {
        const source = this.project.sources.find((item) => path.startsWith(`${item.path}/`))
        if (source) {
          await this.read(path, source.id)
        }
      }
    }
    const tasks = [...this.entries.values()].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
    if (tasks.length > PROJECT_TASK_MAX_COUNT || this.retainedBytes > MAX_INDEX_BYTES) {
      throw new Error('Project task index capacity exceeded (1000 tasks / 8 MiB)')
    }
    return {
      project: this.project,
      tasks,
      diagnostics: [...this.errors.values(), ...validateTaskGraph(this.project, tasks)]
    }
  }

  private async scan(
    source: TaskProject['sources'][number],
    previous: ReadonlyMap<string, ProjectTaskEntry>
  ): Promise<void> {
    const pending = [{ path: source.path, depth: 0 }]
    let count = 0
    while (pending.length) {
      const current = pending.pop()
      if (!current) {
        break
      }
      const target = await taskFilePath(this.root, current.path)
      let directory
      try {
        directory = await opendir(target)
      } catch (error) {
        if (isTaskFileMissing(error)) {
          continue
        }
        throw error
      }
      for await (const entry of directory) {
        if (++count > MAX_DIRECTORY_ENTRIES) {
          throw new Error('Project task directory capacity exceeded')
        }
        const path = `${current.path}/${entry.name}`
        if (entry.isSymbolicLink()) {
          if (entry.name === 'task.md') {
            this.errors.set(path, { path, message: 'Task document must not be a symlink' })
          }
          continue
        }
        if (entry.isDirectory() && !SKIP.has(entry.name)) {
          if (current.depth >= 8) {
            throw new Error('Project task directory depth exceeds 8')
          }
          pending.push({ path, depth: current.depth + 1 })
        } else if (entry.isFile() && entry.name === 'task.md') {
          await this.read(path, source.id, previous.get(path))
          if (this.entries.size + this.errors.size > PROJECT_TASK_MAX_COUNT) {
            throw new Error('Project task index capacity exceeded')
          }
        }
      }
    }
  }

  private async read(path: string, source: string, previous?: ProjectTaskEntry): Promise<void> {
    this.retainedBytes -= Buffer.byteLength(this.entries.get(path)?.content ?? '')
    this.entries.delete(path)
    this.errors.delete(path)
    try {
      const content = await readTaskText(this.root, path)
      const retained =
        previous?.revision === taskRevision(content) && previous.source === source ? previous : null
      if (!retained) {
        this.parseCount++
      }
      this.entries.set(path, retained ?? { ...parseProjectTask(content), path, source })
      this.retainedBytes += Buffer.byteLength(content)
    } catch (error) {
      if (!isTaskFileMissing(error)) {
        this.errors.set(path, {
          path,
          message: 'Invalid or unreadable task document; inspect schema/path/size'
        })
      }
    }
    if (
      this.retainedBytes > MAX_INDEX_BYTES ||
      this.entries.size + this.errors.size > PROJECT_TASK_MAX_COUNT
    ) {
      this.rescan = true
      throw new Error('Project task index capacity exceeded (1000 tasks / 8 MiB)')
    }
  }
}
