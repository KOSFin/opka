import { useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronLeft, RefreshCw } from 'lucide-react-native'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useHostClient } from '../transport/host-client-hooks'
import { useBackClaim } from '../navigation/use-back-claim'
import { useRouteHandoff } from '../navigation/route-handoff'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { colors } from '../theme/mobile-theme'
import { ProjectTaskCatalog, ProjectTaskBoard } from './ProjectTaskLists'
import { ProjectTaskDetail } from './ProjectTaskDetail'
import { projectTaskScreenStyles as styles } from './project-task-screen-styles'
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
  }, [params.hostId, project, task?.id, task?.revision])
  useEffect(() => {
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
  }, [client, state, project, task?.id, task?.revision, refresh])
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
  }, [client, state, project, task?.id, task?.revision, document, refresh])
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
  const projectName = projects.find((item) => item.selector === project)?.name ?? 'Project tasks'
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={back}
          style={styles.iconButton}
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.headerMain}>
          <Text style={styles.title} numberOfLines={1}>
            {document?.split('/').at(-1) ?? task?.title ?? (project ? projectName : 'Tasks')}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {task ? projectName : project ? 'Project board' : 'Projects on this host'}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh project tasks"
          disabled={loading || state !== 'connected'}
          onPress={() => setRefresh((n) => n + 1)}
          style={[styles.iconButton, (loading || state !== 'connected') && styles.disabled]}
        >
          <RefreshCw size={18} color={colors.textSecondary} />
        </Pressable>
      </View>
      {!project ? (
        <MobileSegmentedControl
          fill
          style={styles.tabs}
          selected="project"
          segments={[
            { value: 'project', label: 'Project tasks' },
            { value: 'external', label: 'External trackers' }
          ]}
          onSelect={(value) => {
            if (value === 'external') {
              router.push(`/h/${encodeURIComponent(params.hostId)}/tasks?taskSource=github`)
            }
          }}
        />
      ) : null}
      <ScrollView contentContainerStyle={styles.content}>
        {state !== 'connected' ? (
          <Text style={styles.notice}>
            Host disconnected. Task execution is unverifiable until reconnected.
          </Text>
        ) : null}
        {loading ? (
          <Text accessibilityRole="text" style={styles.meta}>
            Refreshing…
          </Text>
        ) : null}
        {error ? (
          <Text style={styles.notice}>
            {error} Update the execution host if project tasks are unavailable, then refresh.
          </Text>
        ) : null}
        {!project ? (
          <ProjectTaskCatalog
            projects={projects}
            loading={loading}
            onSelect={(selector) => {
              setTask(null)
              setProject(selector)
            }}
          />
        ) : !task ? (
          <ProjectTaskBoard tasks={tasks} loading={loading} onSelect={setTask} />
        ) : (
          <ProjectTaskDetail
            key={`${params.hostId}:${project}:${task.id}`}
            client={client}
            connected={state === 'connected'}
            hostId={params.hostId}
            worktree={project}
            executionHostId={executionHostId}
            task={task}
            body={body}
            documents={documents}
            selectedDocument={document}
            report={report}
            onDocument={setDocument}
            onDone={() => {
              setTask(null)
              setRefresh((n) => n + 1)
            }}
          />
        )}
      </ScrollView>
    </View>
  )
}
