import { MobileSectionReveal } from '../components/MobileSectionReveal'
import { ProjectTaskFilters } from './ProjectTaskFilters'
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
import { ProjectTaskEditor } from './ProjectTaskEditor'
import { ProjectTaskDetail } from './ProjectTaskDetail'
import { projectTaskScreenStyles as styles } from './project-task-screen-styles'
import { useProjectTaskPresentation } from './use-project-task-presentation'

export function MobileProjectTasksScreen() {
  const params = useLocalSearchParams<{ hostId: string }>()
  const { client, state } = useHostClient(params.hostId)
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const {
    projects,
    project,
    executionHostId,
    tasks,
    task,
    body,
    content,
    sources,
    creating,
    documents,
    document,
    report,
    error,
    loading,
    verified,
    selection,
    setProject,
    setTask,
    setDocument,
    setCreating,
    setError,
    setQuery,
    setPhase,
    refreshTasks
  } = useProjectTaskPresentation(client, state, params.hostId)
  function back() {
    setError('')
    if (creating) {
      setCreating(false)
    } else if (document) {
      setDocument(null)
    } else if (task) {
      setTask(null)
    } else if (project) {
      setProject(null)
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
          onPress={() => refreshTasks()}
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
        <MobileSectionReveal
          style={styles.revealContent}
          sectionKey={`${project ?? 'catalog'}:${task?.id ?? 'board'}:${document ?? ''}:${creating ? 'create' : ''}`}
        >
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
            creating ? (
              <ProjectTaskEditor
                key={`${params.hostId}:${project}`}
                client={client}
                connected={state === 'connected' && verified}
                worktree={project}
                executionHostId={executionHostId}
                sources={sources}
                onCancel={() => setCreating(false)}
                onDone={() => {
                  setCreating(false)
                  refreshTasks()
                }}
              />
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add project task"
                  style={styles.row}
                  disabled={loading || !verified || state !== 'connected' || !sources.length}
                  onPress={() => setCreating(true)}
                >
                  <Text style={styles.text}>Add task</Text>
                </Pressable>
                {!loading && !sources.length ? (
                  <Text style={styles.notice}>
                    Task source unavailable. Refresh the project or update its execution host.
                  </Text>
                ) : null}
                <ProjectTaskFilters
                  query={selection.query}
                  phase={selection.phase}
                  onQuery={setQuery}
                  onPhase={setPhase}
                />
                <ProjectTaskBoard
                  tasks={tasks.filter(
                    (item) =>
                      item.title.toLowerCase().includes(selection.query.toLowerCase()) &&
                      (selection.phase === 'all' || item.workflow.phase === selection.phase)
                  )}
                  loading={loading}
                  onSelect={setTask}
                />
              </>
            )
          ) : (
            <ProjectTaskDetail
              key={`${params.hostId}:${project}:${task.id}`}
              client={client}
              connected={state === 'connected' && verified}
              hostId={params.hostId}
              worktree={project}
              executionHostId={executionHostId}
              task={task}
              body={body}
              content={content}
              documents={documents}
              selectedDocument={document}
              report={report}
              onDocument={setDocument}
              onDone={() => {
                setTask(null)
                refreshTasks()
              }}
            />
          )}
        </MobileSectionReveal>
      </ScrollView>
    </View>
  )
}
