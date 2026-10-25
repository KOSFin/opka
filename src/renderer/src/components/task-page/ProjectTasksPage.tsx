import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet'
import { useProjectTaskBoard } from './use-project-task-board'
import { projectTaskCall, type ProjectTaskClient } from './project-task-client'
import { ProjectTaskList } from './ProjectTaskList'
import { ProjectTaskBoard } from './ProjectTaskBoard'
import { ProjectTaskFilters } from './ProjectTaskFilters'
import { ProjectTaskDetail } from './ProjectTaskDetail'
import { ProjectTaskCreate } from './ProjectTaskCreate'
import { ProjectTaskSetup } from './ProjectTaskSetup'
import { ProjectTaskNewButton } from './ProjectTaskNewButton'
import { ProjectTaskConfirm, type ProjectTaskConfirmation } from './ProjectTaskConfirm'
import { ProjectTasksBesideChatButton } from './ProjectTasksBesideChatButton'
import { readProjectTaskView, saveProjectTaskView } from './project-task-view-state'
import { projectTaskNeedsDecision } from '../../../../shared/project-task-attention'
import { useTaskProjectCatalog } from './use-task-project-catalog'
import { useTaskProjectOverview } from './use-task-project-overview'
import {
  projectTaskRows,
  taskViewKey,
  type TaskProjectScope,
  type TaskViewRow
} from './project-task-projects'

const NO_PROJECTS: TaskProjectScope[] = []
export function ProjectTasksPage({ embedded = false }: { embedded?: boolean } = {}) {
  const catalog = useTaskProjectCatalog()
  const [chosen, setChosen] = useState(() => readProjectTaskView().workspace || '*')
  const scope = catalog.projects.find(
    (project) => project.key === chosen || project.selector === chosen
  )
  const workspace = scope?.key ?? '*'
  const target = useMemo(() => scope?.target ?? null, [scope])
  const single = useProjectTaskBoard(
    scope?.state === 'configured' ? target : null,
    scope?.selector ?? ''
  )
  const [limit, setLimit] = useState(16)
  const overview = useTaskProjectOverview(
    workspace === '*' ? catalog.projects : NO_PROJECTS,
    '*',
    catalog.revision,
    limit
  )
  const views = useMemo(
    () =>
      scope && single.board
        ? [{ scope, board: single.board }]
        : workspace === '*'
          ? overview.views
          : [],
    [scope, single.board, workspace, overview.views]
  )
  const allRows = useMemo(() => projectTaskRows(views, workspace === '*'), [views, workspace])
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [repo, setRepo] = useState('*')
  const [source, setSource] = useState('*')
  const [archived, setArchived] = useState(false)
  const [attention, setAttention] = useState(false)
  const [mode, setMode] = useState(() => readProjectTaskView().mode)
  const [creating, setCreating] = useState(false)
  const [closing, setClosing] = useState<ProjectTaskConfirmation | null>(null)
  const [moving, setMoving] = useState<ProjectTaskConfirmation | null>(null)
  const dirty = useRef(false)
  const refreshCatalog = catalog.refresh,
    refreshSingle = single.refresh
  const refresh = useCallback(() => {
    refreshCatalog()
    refreshSingle()
  }, [refreshCatalog, refreshSingle])
  useEffect(() => saveProjectTaskView({ workspace: chosen, mode }), [chosen, mode])
  const choose = (value: string) => {
    const project = catalog.projects.find(
      (entry) => entry.key === value || entry.selector === value
    )
    if (project && project.state !== 'configured') {
      refreshCatalog()
    }
    setChosen(value)
    setSelected('')
    setRepo('*')
    setSource('*')
    setCreating(false)
  }
  const visible = allRows.filter(
    (task) =>
      (archived || !task.workflow.archived) &&
      (repo === '*' || task.repos.includes(repo) || !task.repos.length) &&
      (source === '*' || task.source === source) &&
      (!attention || projectTaskNeedsDecision(task.workflow)) &&
      `${task.title} ${task.projectLabel ?? ''}`.toLowerCase().includes(query.toLowerCase())
  )
  const current = allRows.find(
    (task) => taskViewKey(task) === selected && (archived || !task.workflow.archived)
  )
  const owner = current ? views.find((view) => view.scope.key === current.projectKey) : undefined
  const ownerTarget = owner?.scope.target,
    ownerSelector = owner?.scope.selector,
    ownerHost = owner?.board.executionHostId
  const client = useMemo<ProjectTaskClient | null>(
    () =>
      ownerTarget && ownerSelector && ownerHost
        ? {
            target: ownerTarget,
            worktree: ownerSelector,
            executionHostId: ownerHost
          }
        : null,
    [ownerTarget, ownerSelector, ownerHost]
  )
  const loading = catalog.loading || (scope ? single.loading : overview.loading)
  const errors = [
    ...catalog.errors,
    ...(scope ? (single.error ? [single.error] : []) : overview.errors)
  ]
  const repositories = [
    ...new Set(views.flatMap((view) => Object.keys(view.board.project.repos)))
  ].sort()
  const configuredCount = catalog.projects.filter(
    (project) => project.state === 'configured'
  ).length
  const sources = [
    ...new Set(views.flatMap((view) => view.board.project.sources.map((entry) => entry.id)))
  ].sort()
  const closeDetail = () => {
    if (dirty.current) {
      setClosing({
        title: 'Discard unsaved task edits?',
        description: 'Your saved task and history will stay unchanged.',
        run: async () => {
          dirty.current = false
          setSelected('')
        }
      })
    } else {
      setSelected('')
    }
  }
  const move = (task: TaskViewRow, phase: 'draft' | 'active' | 'review' | 'done') => {
    const view = views.find((entry) => entry.scope.key === task.projectKey)
    if (!view) {
      return
    }
    const client = {
      target: view.scope.target,
      worktree: view.scope.selector,
      executionHostId: view.board.executionHostId
    }
    const run = async (reason: string) => {
      await projectTaskCall(client, 'move', { id: task.id, revision: task.revision, phase, reason })
      refresh()
    }
    if (phase === 'done') {
      setMoving({
        title: 'Complete task',
        description: `Record the result for “${task.title}”. This is your decision, not an automatic verification of CI or deployed code.`,
        reason: true,
        run
      })
    } else {
      void run('').catch((error: unknown) =>
        setMoving({
          title: 'Task could not be moved',
          description: error instanceof Error ? error.message : String(error),
          run: async () => undefined
        })
      )
    }
  }
  const detail = current && client && (
    <ProjectTaskDetail
      key={selected}
      client={client}
      id={current.id}
      version={JSON.stringify(current)}
      refresh={refresh}
      onDeleted={() => setSelected('')}
      onDirtyChange={(value) => {
        dirty.current = value
      }}
    />
  )
  if (embedded && current) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <header className="flex shrink-0 items-center gap-3 border-b p-3">
          <Button variant="ghost" size="sm" onClick={closeDetail}>
            Back to board
          </Button>
          <h2 className="min-w-0 truncate text-sm font-medium">{current.title}</h2>
        </header>
        {detail}
        <ProjectTaskConfirm action={closing} onClose={() => setClosing(null)} />
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <header className="space-y-2 border-b px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="sr-only">Project tasks</h1>
          <Select value={workspace} onValueChange={choose}>
            <SelectTrigger aria-label="Task project">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="*">All projects</SelectItem>
              {catalog.projects.map((project) => (
                <SelectItem key={project.key} value={project.key}>
                  {project.name} · {project.hostLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="min-w-40 flex-1">
            <Input
              aria-label="Search project tasks"
              placeholder="Search tasks…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Button variant="ghost" size="sm" disabled={loading} onClick={refresh}>
            {loading ? 'Checking…' : 'Refresh'}
          </Button>
          {!embedded && <ProjectTasksBesideChatButton />}
          <ProjectTaskNewButton
            projects={catalog.projects}
            selected={scope}
            onCreate={(key) => {
              setChosen(key)
              setSelected('')
              setCreating(true)
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span role="status">
            {visible.length} tasks
            {loading
              ? ' · Checking for changes…'
              : errors.length
                ? ' · Last available data; some hosts unavailable'
                : ''}
          </span>
          <ProjectTaskFilters
            mode={mode}
            setMode={setMode}
            repo={repo}
            setRepo={setRepo}
            source={source}
            setSource={setSource}
            repositories={repositories}
            sources={sources}
            archived={archived}
            setArchived={setArchived}
            attention={attention}
            setAttention={setAttention}
          />
        </div>
      </header>
      {errors.length > 0 && (
        <div role="alert" className="space-y-1 border-b p-4 text-sm text-destructive">
          <p>Some projects could not be loaded. This is not a complete task list.</p>
          {errors.map((error) => (
            <p key={error} className="break-words">
              {error}
            </p>
          ))}
        </div>
      )}
      {scope && scope.state !== 'configured' ? (
        <ProjectTaskSetup key={scope.key} project={scope} refresh={refresh} />
      ) : (
        <>
          {mode === 'board' ? (
            <ProjectTaskBoard
              tasks={visible}
              selected={selected}
              onSelect={setSelected}
              onMove={move}
              onCreate={scope?.state === 'configured' ? () => setCreating(true) : undefined}
            />
          ) : (
            <ProjectTaskList
              tasks={visible}
              selected={selected}
              onSelect={setSelected}
              mode={mode}
            />
          )}
          {!loading && !visible.length && !errors.length && (
            <p className="px-5 pb-3 text-sm text-muted-foreground">
              {catalog.projects.length
                ? 'Create a task for the outcome you want. No repository selection needed.'
                : 'Add a project folder, then create your first task here.'}
            </p>
          )}
          {workspace === '*' && configuredCount > limit && (
            <Button variant="outline" onClick={() => setLimit((value) => value + 16)}>
              Load more projects ({Math.min(limit, configuredCount)} of {configuredCount})
            </Button>
          )}
        </>
      )}
      <details className="border-t px-5 py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">How tasks work · file locations</summary>
        <div className="scrollbar-sleek max-h-48 space-y-2 overflow-auto py-3">
          <p>
            Write a task → refine its plan → work on it → review the result. Open a card for its
            plan, activity, and execution. Working copies are Git checkouts, not tasks.
          </p>
          <p>
            Plans are ordinary task.md files in the project. Notes and checkpoints stay alongside
            them. Copy resume context inside a task to continue in another chat or account.
          </p>
          <p>
            Returning shows the last snapshot while checking its owning host. An unavailable host
            does not mean an agent stopped. All projects is checked on opening or Refresh; a
            selected project also receives live updates.
          </p>
          {views.map((view) => (
            <p key={view.scope.key} className="break-all">
              {view.scope.name} · {view.scope.hostLabel}: {view.scope.root} —{' '}
              {view.board.project.sources.map((entry) => entry.path).join(', ')}
            </p>
          ))}
          {catalog.projects
            .filter((project) => project.state !== 'configured')
            .map((project) => (
              <Button
                key={project.key}
                variant="link"
                size="sm"
                onClick={() => choose(project.key)}
              >
                Set up {project.name} · {project.hostLabel}
              </Button>
            ))}
          {views.flatMap((view) =>
            view.board.diagnostics.map((item) => (
              <p key={`${view.scope.key}:${item.path}`}>
                {view.scope.name}: {item.path}: {item.message}
              </p>
            ))
          )}
        </div>
      </details>
      <Sheet
        open={!!current}
        onOpenChange={(open) => {
          if (!open) {
            closeDetail()
          }
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{current?.title}</SheetTitle>
            <SheetDescription>
              {owner?.scope.name} · {owner?.scope.hostLabel}
            </SheetDescription>
          </SheetHeader>
          {detail}
        </SheetContent>
      </Sheet>
      <ProjectTaskConfirm action={closing} onClose={() => setClosing(null)} />
      <ProjectTaskConfirm action={moving} onClose={() => setMoving(null)} />
      {creating && scope && single.board && (
        <ProjectTaskCreate
          client={{
            target: scope.target,
            worktree: scope.selector,
            executionHostId: single.board.executionHostId
          }}
          project={single.board.project}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            setSelected(JSON.stringify([scope.key, id]))
            refresh()
          }}
        />
      )}
    </div>
  )
}
