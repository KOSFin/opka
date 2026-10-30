import { useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, View, StyleSheet } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useHostClient } from '../transport/host-client-hooks'
import { useBackClaim } from '../navigation/use-back-claim'
import { useRouteHandoff } from '../navigation/route-handoff'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { ProjectTaskSessionLink } from './ProjectTaskSessionLink'
import { ProjectTaskLaunch } from './ProjectTaskLaunch'
import { ProjectTaskDecision } from './ProjectTaskDecision'
import {
  catalogRead,
  documentsRead,
  loadProjectTaskBoard,
  taskRead,
  type MobileProjectTask
} from './project-task-rpc'

export function MobileProjectTasksScreen() {
  const params = useLocalSearchParams<{ hostId: string }>()
  const { client, state } = useHostClient(params.hostId)
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const [refresh, setRefresh] = useState(0)
  const [projects, setProjects] = useState<
    { selector: string; name: string; state: string; message?: string }[]
  >([])
  const [project, setProject] = useState<string | null>(null)
  const [executionHostId, setExecutionHostId] = useState('')
  const [tasks, setTasks] = useState<MobileProjectTask[]>([])
  const [task, setTask] = useState<MobileProjectTask | null>(null)
  const [body, setBody] = useState('')
  const [documents, setDocuments] = useState<string[]>([])
  const [document, setDocument] = useState<string | null>(null)
  const [report, setReport] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    setProjects([])
    setProject(null)
    setTasks([])
    setTask(null)
  }, [params.hostId])
  useEffect(() => {
    if (!client || state !== 'connected') {
      return
    }
    let current = true
    setLoading(true)
    setError('')
    void (async () => {
      if (!project) {
        const result = catalogRead.interpret(await catalogRead.request(client))
        if (current) {
          setProjects(result.projects)
        }
      } else {
        const result = await loadProjectTaskBoard(client, project)
        if (current) {
          setTasks(result.tasks)
          setTask((selected) =>
            selected ? (result.tasks.find((item) => item.id === selected.id) ?? null) : null
          )
          setExecutionHostId(result.executionHostId)
        }
      }
    })()
      .catch((failure: unknown) => {
        if (current) {
          setError(failure instanceof Error ? failure.message : 'Could not read project tasks.')
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false)
        }
      })
    return () => {
      current = false
    }
  }, [client, state, project, refresh])
  useEffect(() => {
    setBody('')
    setDocuments([])
    setDocument(null)
    if (!client || !project || !task || state !== 'connected') {
      return
    }
    let current = true
    void Promise.all([
      taskRead.request(client, { worktree: project, id: task.id }).then(taskRead.interpret),
      documentsRead
        .request(client, { worktree: project, id: task.id })
        .then(documentsRead.interpret)
    ])
      .then(([detail, files]) => {
        if (!current) {
          return
        }
        if (detail.revision !== task.revision) {
          throw new Error('Task changed. Return to the board and refresh.')
        }
        setBody(detail.body)
        setDocuments(files.paths)
      })
      .catch((failure: unknown) => {
        if (current) {
          setError(String(failure))
        }
      })
    return () => {
      current = false
    }
  }, [client, state, project, task])
  useEffect(() => {
    setReport('')
    if (!client || !project || !task || !document || state !== 'connected') {
      return
    }
    let current = true
    void documentsRead
      .request(client, { worktree: project, id: task.id, path: document })
      .then(documentsRead.interpret)
      .then((result) => {
        if (current) {
          setReport(result.content ?? '')
        }
      })
      .catch((failure: unknown) => {
        if (current) {
          setError(String(failure))
        }
      })
    return () => {
      current = false
    }
  }, [client, state, project, task, document])
  function back() {
    setError('')
    if (document) {
      setDocument(null)
    } else if (task) {
      setTask(null)
    } else if (project) {
      setProject(null)
      setTasks([])
    } else {
      router.back()
    }
  }
  useBackClaim(
    project
      ? () => {
          back()
          return true
        }
      : null
  )
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={back} style={styles.button}>
          <Text style={styles.text}>Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {task?.title ?? 'Project tasks'}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={loading || state !== 'connected'}
          onPress={() => setRefresh((n) => n + 1)}
          style={styles.button}
        >
          <Text style={styles.text}>Refresh</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {state !== 'connected' ? (
          <Text style={styles.notice}>
            Host disconnected. Task execution is unverifiable until reconnected.
          </Text>
        ) : null}
        {loading ? <Text style={styles.meta}>Refreshing…</Text> : null}
        {error ? (
          <Text style={styles.notice}>
            {error} Update the execution host if project tasks are unavailable, then refresh.
          </Text>
        ) : null}
        {!project ? (
          <>
            <Text style={styles.meta}>Choose a project on this host.</Text>
            {projects.map((item) => (
              <Pressable
                accessibilityRole="button"
                key={item.selector}
                disabled={item.state !== 'configured'}
                style={styles.row}
                onPress={() => setProject(item.selector)}
              >
                <Text style={styles.text}>{item.name}</Text>
                <Text style={styles.meta}>
                  {item.state === 'configured'
                    ? 'Tasks, reports and activity'
                    : (item.message ?? 'Task board not configured')}
                </Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              style={styles.row}
              onPress={() =>
                router.push(`/h/${encodeURIComponent(params.hostId)}/tasks?taskSource=github`)
              }
            >
              <Text style={styles.text}>External trackers</Text>
            </Pressable>
          </>
        ) : !task ? (
          <>
            <Text style={styles.title}>{projects.find((p) => p.selector === project)?.name}</Text>
            {!loading && tasks.length === 0 ? (
              <Text style={styles.meta}>No tasks in this project.</Text>
            ) : null}
            {tasks.map((item) => (
              <Pressable
                accessibilityRole="button"
                key={item.id}
                style={styles.row}
                onPress={() => setTask(item)}
              >
                <Text style={styles.text}>{item.title}</Text>
                <Text style={styles.meta}>
                  {item.workflow.phase}
                  {item.workflow.archived ? ' · Archived' : ''}
                  {item.workflow.revisionChanged ? ' · Plan changed' : ''}
                </Text>
              </Pressable>
            ))}
          </>
        ) : document ? (
          <>
            <Text style={styles.meta}>{document}</Text>
            <MobileMarkdown content={report} fallback="Loading document…" />
          </>
        ) : (
          <>
            <Text style={styles.meta}>
              {task.workflow.phase} · {task.path}
            </Text>
            <MobileMarkdown content={body} fallback="Loading task…" />
            <ProjectTaskLaunch
              key={`${params.hostId}:${project}:${task.id}`}
              client={client}
              connected={state === 'connected'}
              hostId={params.hostId}
              worktree={project}
              executionHostId={executionHostId}
              task={task}
            />
            <Text style={styles.title}>Reports and checkpoints</Text>
            {documents.length === 0 ? <Text style={styles.meta}>No saved reports yet.</Text> : null}
            {documents.map((path) => (
              <Pressable
                accessibilityRole="button"
                style={styles.row}
                key={path}
                onPress={() => setDocument(path)}
              >
                <Text style={styles.text}>{path.split('/').at(-1)}</Text>
              </Pressable>
            ))}
            <Text style={styles.title}>Attempts</Text>
            {task.workflow.attempts.map((attempt) => (
              <View style={styles.row} key={attempt.id}>
                <Text style={styles.text}>{attempt.nativeStatus}</Text>
                <Text selectable style={styles.meta}>
                  {attempt.session?.address ?? attempt.terminal ?? 'No agent session recorded'}
                </Text>
                {attempt.session?.address || attempt.terminal ? (
                  <ProjectTaskSessionLink
                    client={client}
                    connected={state === 'connected'}
                    hostId={params.hostId}
                    terminal={attempt.session?.address ?? attempt.terminal ?? ''}
                  />
                ) : null}
                {attempt.session?.blocker ? (
                  <Text style={styles.notice}>{attempt.session.blocker}</Text>
                ) : null}
              </View>
            ))}
            <ProjectTaskDecision
              key={task.id}
              client={client}
              connected={state === 'connected'}
              worktree={project}
              executionHostId={executionHostId}
              task={task}
              onDone={() => {
                setTask(null)
                setRefresh((n) => n + 1)
              }}
            />
            <Text style={styles.title}>Activity</Text>
            {task.workflow.events.map((event) => (
              <View style={styles.row} key={event.sequence}>
                <Text style={styles.text}>
                  {event.kind}: {event.detail}
                </Text>
                <Text style={styles.meta}>{event.createdAt}</Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  )
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  content: { padding: spacing.lg, gap: spacing.md },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    flexShrink: 1,
    fontWeight: '600'
  },
  text: { color: colors.textPrimary, fontSize: typography.bodySize },
  meta: { color: colors.textSecondary, fontSize: typography.metaSize },
  notice: { color: colors.statusAmber, fontSize: typography.bodySize },
  button: { minHeight: 48, paddingHorizontal: spacing.lg, justifyContent: 'center' },
  row: {
    minHeight: 48,
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  }
})
