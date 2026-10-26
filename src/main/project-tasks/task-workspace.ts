import { lstat, realpath, unlink } from 'node:fs/promises'
import {
  PROJECT_TASK_CONFIG_PATH,
  type ProjectTaskSnapshot,
  type TaskProject
} from '../../shared/project-task-contract'
import { withFileTransactionLock } from '../file-transaction-lock'
import { writePluginFileAtomically } from '../plugins/plugin-atomic-file-write'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import { parseProjectTask, parseTaskProject, taskRevision } from './task-document'
import { isTaskFileMissing, readTaskText, taskFilePath } from './task-file-io'
import { TaskFileIndex } from './task-file-index'
import { validateTaskGraph } from './task-graph'
import { buildTaskContext } from './task-context'
import { initializeTaskFiles } from './task-workspace-init'
import { configureTaskAgentSettings, readTaskAgentSettings } from './task-agent-settings'

export type TaskRootWatch = (
  root: string,
  changed: (paths: string[] | null) => void,
  failed: () => void
) => Promise<() => Promise<void>>

export class TaskWorkspace {
  private index: TaskFileIndex | null = null
  private configRevision = ''
  private readonly queues = new Map<string, Promise<void>>()
  private releases: (() => Promise<void>)[] = []
  private idle: ReturnType<typeof setTimeout> | null = null
  private watchBroken = false
  private readonly listeners = new Set<() => void>()

  get subscribed(): boolean {
    return this.listeners.size > 0
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      // The existing idle timer releases watches; brief navigation keeps a warm index.
      if (!this.listeners.size) {
        this.armIdleCleanup()
      }
    }
  }

  notifyChanged(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  constructor(
    private readonly root: string,
    private readonly watch?: TaskRootWatch
  ) {}

  get parseCount(): number {
    return this.index?.parseCount ?? 0
  }

  async initialize(content?: string): Promise<TaskProject> {
    return this.writeLocked(() => initializeTaskFiles(this.root, content))
  }

  async enableAgentTasks() {
    const settings = await this.agentSettings('enable')
    return { paths: settings.files.map((file) => file.path) }
  }

  async agentSettings(action: 'read' | 'reconcile' | 'enable' | 'disable' = 'read') {
    return action === 'read'
      ? readTaskAgentSettings(this.root)
      : this.writeLocked(() => configureTaskAgentSettings(this.root, action))
  }

  snapshot(): Promise<ProjectTaskSnapshot> {
    return runKeyedSerializedOperation(this.queues, 'index', async () => {
      const config = await readTaskText(this.root, PROJECT_TASK_CONFIG_PATH).catch(
        (error: unknown) => {
          if (isTaskFileMissing(error)) {
            throw new Error(
              'Task files are not set up for this project. Open Project tasks and choose Set up task files.'
            )
          }
          throw error
        }
      )
      const revision = taskRevision(config)
      if (!this.index || revision !== this.configRevision) {
        await this.closeWatches()
        const project = parseTaskProject(config)
        this.index = new TaskFileIndex(await realpath(this.root), project)
        this.configRevision = revision
      }
      if (this.watchBroken) {
        await this.closeWatches()
        this.index.invalidate(null)
        this.watchBroken = false
      }
      if (this.watch && this.releases.length === 0) {
        this.index.invalidate(null)
        try {
          for (const source of this.index.project.sources) {
            const path = await taskFilePath(this.root, source.path)
            this.releases.push(
              await this.watch(
                path,
                (paths) => {
                  this.index?.invalidate(paths)
                  this.notifyChanged()
                },
                () => {
                  this.watchBroken = true
                  this.notifyChanged()
                }
              )
            )
          }
        } catch (error) {
          await this.closeWatches()
          this.index.invalidate(null)
          throw error
        }
      } else if (!this.watch) {
        this.index.invalidate(null)
      }
      this.armIdleCleanup()
      return this.index.snapshot()
    })
  }

  async show(id: string) {
    return (await this.selectedTask(id)).task
  }

  private armIdleCleanup(): void {
    if (this.idle) {
      clearTimeout(this.idle)
    }
    this.idle = setTimeout(() => {
      if (!this.listeners.size) {
        void this.close().catch(() => undefined)
      }
    }, 30_000)
    this.idle.unref()
  }

  async withTaskRevision<T>(
    id: string,
    revision: string,
    operation: (
      task: Awaited<ReturnType<TaskWorkspace['show']>>,
      snapshot: ProjectTaskSnapshot
    ) => Promise<T>
  ): Promise<T> {
    return this.writeLocked(async () => {
      const task = await this.show(id)
      if (task.revision !== revision) {
        throw new Error('Task revision conflict; re-read before acting')
      }
      return operation(task, await this.snapshot())
    })
  }

  async deleteDocument(
    id: string,
    revision: string,
    guard?: (task: Awaited<ReturnType<TaskWorkspace['show']>>) => void
  ): Promise<void> {
    await this.withTaskRevision(id, revision, async (task, snapshot) => {
      guard?.(task)
      if (snapshot.tasks.some((other) => other.parent === id || other.depends_on.includes(id))) {
        throw new Error('Remove incoming task references before deleting this document')
      }
      await unlink(await taskFilePath(this.root, task.path))
      this.index?.invalidate(null)
      this.notifyChanged()
    })
  }

  async context(id: string) {
    const { task, project } = await this.selectedTask(id)
    return buildTaskContext(this.root, project, task)
  }

  async create(sourceId: string, slug: string, content: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(slug)) {
      throw new Error('Invalid task directory slug')
    }
    const document = parseProjectTask(content)
    return this.writeLocked(async () => {
      this.index?.invalidate(null)
      const snapshot = await this.snapshot()
      const source = snapshot.project.sources.find((entry) => entry.id === sourceId)
      if (!source) {
        throw new Error('Unknown registered task source')
      }
      const path = `${source.path}/${slug}/task.md`
      const entry = { ...document, source: sourceId, path }
      const diagnostics = [
        ...snapshot.diagnostics,
        ...validateTaskGraph(snapshot.project, [...snapshot.tasks, entry])
      ]
      if (diagnostics.length) {
        throw new Error(diagnostics[0].message)
      }
      this.assertWriteCapacity([...snapshot.tasks, entry])
      const target = await taskFilePath(this.root, path, true)
      if (
        await lstat(target).catch((error: unknown) => {
          if (isTaskFileMissing(error)) {
            return null
          }
          throw error
        })
      ) {
        throw new Error('Task file already exists')
      }
      await writePluginFileAtomically(target, content, { mode: 0o644 })
      this.notifyChanged()
      this.index?.invalidate([target])
      return entry
    })
  }

  async update(id: string, expectedRevision: string, content: string) {
    const document = parseProjectTask(content)
    if (document.id !== id) {
      throw new Error('Task identity cannot change during update')
    }
    return this.writeLocked(async () => {
      this.index?.invalidate(null)
      const snapshot = await this.snapshot()
      const task = await this.show(id)
      const current = await readTaskText(this.root, task.path)
      if (taskRevision(current) !== expectedRevision) {
        throw new Error('Task revision conflict; re-read before editing')
      }
      const next = { ...document, source: task.source, path: task.path }
      const diagnostics = validateTaskGraph(
        snapshot.project,
        snapshot.tasks.map((entry) => (entry.id === id ? next : entry))
      )
      if (diagnostics.length) {
        throw new Error(diagnostics[0].message)
      }
      this.assertWriteCapacity(snapshot.tasks.map((entry) => (entry.id === id ? next : entry)))
      const target = await taskFilePath(this.root, task.path)
      const mode = (await lstat(target)).mode & 0o777
      await writePluginFileAtomically(target, content, { mode })
      this.notifyChanged()
      this.index?.invalidate([target])
      return next
    })
  }

  close(): Promise<void> {
    return runKeyedSerializedOperation(this.queues, 'index', async () => {
      if (this.idle) {
        clearTimeout(this.idle)
        this.idle = null
      }
      await this.closeWatches()
      this.index?.invalidate(null)
    })
  }

  private async closeWatches(): Promise<void> {
    await Promise.all(this.releases.splice(0).map((release) => release()))
  }

  private async writeLocked<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await taskFilePath(this.root, '.orca/project-tasks', true)
    return withFileTransactionLock(lock, operation, { preserveDirectoryPermissions: true })
  }

  private assertWriteCapacity(tasks: { content: string }[]): void {
    if (
      tasks.length > 1000 ||
      tasks.reduce((sum, task) => sum + Buffer.byteLength(task.content), 0) > 8 * 1024 * 1024
    ) {
      throw new Error('Project task index capacity exceeded (1000 tasks / 8 MiB)')
    }
  }

  private async selectedTask(id: string) {
    let snapshot = await this.snapshot()
    let task = snapshot.tasks.find((entry) => entry.id === id)
    if (task && taskRevision(await readTaskText(this.root, task.path)) !== task.revision) {
      this.index?.invalidate([await taskFilePath(this.root, task.path)])
      snapshot = await this.snapshot()
      task = snapshot.tasks.find((entry) => entry.id === id)
    }
    if (snapshot.diagnostics.length) {
      throw new Error('Project task index is invalid; inspect list diagnostics')
    }
    if (!task) {
      throw new Error('Project task not found')
    }
    return { task, project: snapshot.project }
  }
}
