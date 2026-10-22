import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskWorkspace } from './task-workspace'

const roots: string[] = []
const services: TaskWorkspace[] = []
const first = 'task-11111111-1111-4111-8111-111111111111'
const second = 'task-22222222-2222-4222-8222-222222222222'
function task(id = first, deps: string[] = []): string {
  return `---\nschema: 1\nid: ${id}\ntitle: Pipeline\nkind: implementation\nrepos: [root]\ndepends_on: ${JSON.stringify(deps)}\n---\n# Goal\nFix pipeline.\n\n## Plan\n- [ ] Investigate\n\n## Acceptance\n- [ ] Verify exact SHA\n`
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-project-tasks-')))
  roots.push(root)
  let notify: (paths: string[] | null) => void = () => undefined
  let subscriptions = 0
  let fail: () => void = () => undefined
  const workspace = new TaskWorkspace(root, async (_path, changed, failed) => {
    subscriptions++
    notify = changed
    fail = failed
    return async () => undefined
  })
  services.push(workspace)
  await workspace.initialize()
  return {
    root,
    workspace,
    notify: (paths: string[] | null) => notify(paths),
    fail: () => fail(),
    subscriptions: () => subscriptions
  }
}
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(services.splice(0).map((workspace) => workspace.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('file-backed task workspace', () => {
  it('releases watches after leaving a long-lived view rather than leaking them when its first idle timer elapsed', async () => {
    const { workspace, subscriptions } = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await workspace.snapshot()
    const release = workspace.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(31000)
    release()
    await vi.advanceTimersByTimeAsync(31000)
    await workspace.snapshot()
    expect(subscriptions()).toBe(2)
  })
  it('retains parsed documents on navigation and reconciles changes across an idle watch gap', async () => {
    const { root, workspace, subscriptions } = await fixture()
    await workspace.create('project', 'one', task())
    await workspace.create('project', 'two', task(second))
    await workspace.snapshot()
    const parses = workspace.parseCount
    const watchers = subscriptions()
    const release = workspace.subscribe(() => undefined)
    release()
    await workspace.snapshot()
    expect(workspace.parseCount).toBe(parses)
    expect(subscriptions()).toBe(watchers)
    await workspace.close()
    await workspace.snapshot()
    expect(workspace.parseCount).toBe(parses)
    expect(subscriptions()).toBe(watchers + 1)
    await workspace.close()
    await writeFile(
      join(root, 'docs/work/tasks/one/task.md'),
      task().replace('Pipeline', 'Changed elsewhere')
    )
    await rm(join(root, 'docs/work/tasks/two'), { recursive: true })
    await mkdir(join(root, 'docs/work/tasks/new'))
    await writeFile(join(root, 'docs/work/tasks/new/task.md'), task(second))
    const snapshot = await workspace.snapshot()
    expect(snapshot.tasks).toHaveLength(2)
    expect(snapshot.tasks.find((entry) => entry.id === first)?.title).toBe('Changed elsewhere')
    expect(snapshot.tasks.find((entry) => entry.id === second)?.path).toContain('/new/')
    expect(workspace.parseCount).toBe(parses + 2)
  })
  it('creates, reads and restores context in a fresh service without any account or DB', async () => {
    const { root, workspace } = await fixture()
    await workspace.create('project', 'pipeline', task())
    const before = await workspace.show(first)
    await writeFile(join(root, 'docs/work/tasks/pipeline/checkpoint.md'), 'Next: review the diff.')
    const fresh = new TaskWorkspace(root)
    services.push(fresh)
    const context = await fresh.context(first)
    expect(context.execution).toBe('unknown')
    expect(context.approval).toBe('unverified')
    expect(context.revision).toBe(before.revision)
    expect(context.text).toContain('Next: review the diff.')
    expect(context.text).toContain('Fix pipeline.')
    expect(context.text.length).toBeLessThanOrEqual(8_000)
    await expect(workspace.initialize()).rejects.toThrow(/exists/)
  })

  it('serializes two writers and refuses the stale revision without losing custom text', async () => {
    const { root, workspace } = await fixture()
    await workspace.create('project', 'pipeline', task())
    const before = await workspace.show(first)
    const other = new TaskWorkspace(root)
    services.push(other)
    const content = `${before.content}\n## Custom\nKeep this.\n`
    const results = await Promise.allSettled([
      workspace.update(first, before.revision, content),
      other.update(first, before.revision, `${content}Other writer\n`)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await readFile(join(root, before.path), 'utf8')).toContain('Keep this.')
    await expect(workspace.update(first, before.revision, task())).rejects.toThrow(/revision/)
  })

  it('does not reparse idle files and updates only the notified document', async () => {
    const { root, workspace, notify, subscriptions } = await fixture()
    await workspace.create('project', 'one', task())
    await workspace.create('project', 'two', task(second, [first]))
    await workspace.snapshot()
    const reads = workspace.parseCount
    await workspace.snapshot()
    expect(workspace.parseCount).toBe(reads)
    expect(subscriptions()).toBe(1)
    const file = join(root, 'docs/work/tasks/one/task.md')
    await writeFile(file, task().replace('Fix pipeline.', 'Changed goal.'))
    notify([file])
    expect((await workspace.show(first)).body).toContain('Changed goal.')
    expect(workspace.parseCount).toBe(reads + 1)
    await rename(join(root, 'docs/work/tasks/one'), join(root, 'docs/work/tasks/renamed'))
    notify(null)
    expect((await workspace.show(first)).path).toContain('renamed/task.md')
  })

  it('reports cycles, missing refs and duplicate IDs instead of pretending work is ready', async () => {
    const { root, workspace, notify } = await fixture()
    await workspace.create('project', 'one', task())
    await workspace.create('project', 'two', task(second, [first]))
    await expect(
      workspace.update(first, (await workspace.show(first)).revision, task(first, [second]))
    ).rejects.toThrow(/cycle/)
    await mkdir(join(root, 'docs/work/tasks/duplicate'))
    await writeFile(join(root, 'docs/work/tasks/duplicate/task.md'), task())
    notify(null)
    expect(
      (await workspace.snapshot()).diagnostics.some((item) => /Duplicate/.test(item.message))
    ).toBe(true)
    await expect(workspace.context(first)).rejects.toThrow(/invalid/)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects traversal and symlink sources/documents without modifying their targets',
    async () => {
      const { root, workspace, notify } = await fixture()
      await expect(workspace.create('project', '../escape', task())).rejects.toThrow()
      const outside = await mkdtemp(join(tmpdir(), 'orca-task-outside-'))
      roots.push(outside)
      await mkdir(join(root, 'docs/work/tasks/unsafe'))
      await writeFile(join(outside, 'task.md'), task())
      await symlink(join(outside, 'task.md'), join(root, 'docs/work/tasks/unsafe/task.md'))
      notify(null)
      expect((await workspace.snapshot()).tasks).toHaveLength(0)
      await expect(workspace.create('project', 'unsafe', task())).rejects.toThrow()
      expect(await readFile(join(outside, 'task.md'), 'utf8')).toBe(task())
    }
  )

  it('rearms a failed watcher and releases idle subscriptions without stale reads', async () => {
    const { root, workspace, fail, subscriptions } = await fixture()
    await workspace.create('project', 'one', task())
    await workspace.snapshot()
    const before = subscriptions()
    fail()
    await writeFile(
      join(root, 'docs/work/tasks/one/task.md'),
      task().replace('Fix pipeline.', 'Updated while disconnected.')
    )
    expect((await workspace.show(first)).body).toContain('Updated while disconnected.')
    expect(subscriptions()).toBe(before + 1)
    await workspace.close()
    await workspace.show(first)
    expect(subscriptions()).toBe(before + 2)
  })

  it.skipIf(process.platform === 'win32')(
    'preserves document and metadata directory permissions during managed writes',
    async () => {
      const { root, workspace } = await fixture()
      await workspace.create('project', 'one', task())
      const before = await workspace.show(first)
      await chmod(join(root, '.orca'), 0o750)
      await chmod(join(root, before.path), 0o640)
      await workspace.update(first, before.revision, `${before.content}\nPreserved permissions.\n`)
      expect((await lstat(join(root, before.path))).mode & 0o777).toBe(0o640)
      expect((await lstat(join(root, '.orca'))).mode & 0o777).toBe(0o750)
    }
  )

  it('combines repo roots and refuses missing references and unknown repos', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-task-roots-')))
    roots.push(root)
    const workspace = new TaskWorkspace(root)
    services.push(workspace)
    await workspace.initialize(
      JSON.stringify({
        schema: 1,
        id: 'project-11111111-1111-4111-8111-111111111111',
        repos: { root: '.', backend: 'backend', frontend: 'frontend' },
        sources: [
          { id: 'common', path: 'docs/tasks' },
          { id: 'frontend', path: 'frontend/docs/tasks' }
        ]
      })
    )
    await workspace.create(
      'common',
      'backend-fix',
      task().replace('repos: [root]', 'repos: [backend]')
    )
    await workspace.create(
      'frontend',
      'frontend-fix',
      task(second, [first]).replace('repos: [root]', 'repos: [frontend]')
    )
    expect((await workspace.snapshot()).tasks.map((entry) => entry.source)).toEqual([
      'common',
      'frontend'
    ])
    const childId = 'task-55555555-5555-4555-8555-555555555555'
    await workspace.create(
      'frontend',
      'child',
      task(childId, [second]).replace(
        'kind: implementation',
        `kind: implementation\nparent: ${first}`
      )
    )
    expect((await workspace.show(childId)).parent).toBe(first)
    await expect(
      workspace.create(
        'common',
        'missing',
        task('task-33333333-3333-4333-8333-333333333333', [
          'task-44444444-4444-4444-8444-444444444444'
        ])
      )
    ).rejects.toThrow(/Missing task reference/)
    const existing = await workspace.show(second)
    await expect(
      workspace.update(
        second,
        existing.revision,
        existing.content.replace('repos: [frontend]', 'repos: [unknown]')
      )
    ).rejects.toThrow(/Unknown repository/)
  })

  it('bounds context and rejects future schemas without changing the file', async () => {
    const { root, workspace } = await fixture()
    await workspace.create('project', 'one', task() + 'x'.repeat(20_000))
    const context = await workspace.context(first)
    expect(context.truncated).toBe(true)
    expect(context.text.length).toBeLessThanOrEqual(8_000)
    expect(context.text).toContain('Truncated')
    const before = await workspace.show(first)
    await expect(
      workspace.update(first, before.revision, before.content.replace('schema: 1', 'schema: 2'))
    ).rejects.toThrow()
    expect(await readFile(join(root, before.path), 'utf8')).toBe(before.content)
  })

  it('checks the selected file even before a delayed watcher event arrives', async () => {
    const { root, workspace } = await fixture()
    await workspace.create('project', 'one', task())
    await workspace.snapshot()
    await writeFile(
      join(root, 'docs/work/tasks/one/task.md'),
      task().replace('Fix pipeline.', 'Fresh goal before notification.')
    )
    expect((await workspace.context(first)).text).toContain('Fresh goal before notification.')
  })

  it('fails explicitly on aggregate document capacity rather than returning a partial index', async () => {
    const { root, workspace, notify } = await fixture()
    for (let index = 0; index < 34; index++) {
      const directory = join(root, `docs/work/tasks/large-${index}`)
      await mkdir(directory)
      const id = `task-${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
      await writeFile(join(directory, 'task.md'), task(id) + 'x'.repeat(250_000))
    }
    notify(null)
    await expect(workspace.snapshot()).rejects.toThrow(/capacity/)
    await expect(workspace.snapshot()).rejects.toThrow(/capacity/)
  })
})
