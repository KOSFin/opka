import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stringify } from 'yaml'
import { projectTaskTemplate } from '../../src/shared/project-task-template.ts'

export function prepareAcceptanceFixture(root) {
  const marker = path.join(root, '.fork-acceptance.json')
  if (existsSync(marker)) {
    return
  }
  if (existsSync(root)) {
    throw new Error('Refusing to seed an existing unmarked workspace')
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const repos = { backend: 'services/backend', worker: 'services/worker', web: 'apps/web' }
  for (const [name, relative] of Object.entries(repos)) {
    const cwd = path.join(root, relative)
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    execFileSync('git', ['init', cwd], { stdio: 'ignore' })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd })
    writeFileSync(path.join(cwd, 'README.md'), `# Acceptance ${name}\nSynthetic data only.\n`)
    execFileSync('git', ['add', 'README.md'], { cwd })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fork acceptance',
        '-c',
        'user.email=test@invalid.example',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-m',
        'Synthetic acceptance fixture'
      ],
      { cwd, stdio: 'ignore' }
    )
  }
  mkdirSync(path.join(root, '.orca'), { mode: 0o700 })
  writeFileSync(
    path.join(root, '.orca/project.yaml'),
    stringify({
      schema: 1,
      id: `project-${randomUUID()}`,
      repos,
      sources: [{ id: 'project', path: 'docs/work/tasks' }]
    }),
    { mode: 0o600 }
  )
  const parent = `task-${randomUUID()}`
  const tasks = [
    { id: parent, title: 'Проверить связку backend и web', repos: ['backend', 'web'] },
    { id: `task-${randomUUID()}`, title: 'Учебная подзадача backend', repos: ['backend'], parent },
    { id: `task-${randomUUID()}`, title: 'Независимая проверка worker', repos: ['worker'] }
  ]
  for (const [index, task] of tasks.entries()) {
    const dir = path.join(root, 'docs/work/tasks', `sample-${index + 1}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    let content = projectTaskTemplate({ ...task, detailed: true })
    if (task.parent) {
      content = content.replace('parent: null', `parent: ${task.parent}`)
    }
    content += '\n## User test notes\nThis section must survive editing and restart.\n'
    writeFileSync(path.join(dir, 'task.md'), content, { mode: 0o600 })
    writeFileSync(
      path.join(dir, 'notes.md'),
      '# Учебные заметки\nНе перезаписывать автоматически.\n',
      { mode: 0o600 }
    )
  }
  writeFileSync(marker, JSON.stringify({ schema: 1, synthetic: true, tasks }, null, 2), {
    mode: 0o600
  })
}
