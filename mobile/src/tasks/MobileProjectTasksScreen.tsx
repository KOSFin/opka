import { ProjectTaskFilters } from './ProjectTaskFilters'
import { useEffect, useRef } from 'react'
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { ChevronLeft, RefreshCw } from 'lucide-react-native'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useHostClient } from '../transport/host-client-hooks'
import { useOptionalHostProtocolGates } from '../components/host-protocol-gates-context'
import { PROJECT_TASK_PROJECT_AGENTS_CAPABILITY } from '../../../src/shared/project-task-delegation'
import { useBackClaim } from '../navigation/use-back-claim'
import { useRouteHandoff } from '../navigation/route-handoff'
import { MobileSegmentedControl, MobileSectionReveal } from '../components/MobileSegmentedControl'
import { colors } from '../theme/mobile-theme'
import { ProjectTaskCatalog, ProjectTaskBoard } from './ProjectTaskLists'
import { ProjectTaskEditor } from './ProjectTaskEditor'
import { ProjectTaskDetail } from './ProjectTaskDetail'
import { ProjectTaskPolicy } from './ProjectTaskPolicy'
import { projectTaskScreenStyles as styles } from './project-task-screen-styles'
import { useProjectTaskPresentation } from './use-project-task-presentation'

export function MobileProjectTasksScreen() {
  const params = useLocalSearchParams<{ hostId: string }>()
  const { client, state } = useHostClient(params.hostId)
  const hostGates = useOptionalHostProtocolGates()
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const {
    projects,
    catalogTruncated,
    project,
    executionHostId,
    tasks,
    overview,
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
    setProjectTask,
    setTask,
    setDocument,
    setCreating,
    setError,
    setQuery,
    setPhase,
    setSource,
    setProjects,
    loadMoreProjects,
    setScroll,
    refreshTasks
  } = useProjectTaskPresentation(client, state, params.hostId)
  const scrollRef = useRef<ScrollView>(null)
  const scrollScope = `${params.hostId}:${project ?? 'catalog'}:${task?.id ?? ''}:${document ?? ''}:${creating}`
  useEffect(() => {
    scrollRef.current?.scrollTo?.({
      y:
        task || document || creating
          ? 0
          : project
            ? selection.boardScroll
            : selection.catalogScroll,
      animated: false
    })
  }, [scrollScope])
  const rememberScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!task && !document && !creating) {
      setScroll(project ? 'boardScroll' : 'catalogScroll', event.nativeEvent.contentOffset.y)
    }
  }
  const configured = projects.filter((item) => item.state === 'configured')
  const selectedAll =
    selection.projects.includes('*') ||
    (configured.length > 0 &&
      configured.every((item) => selection.projects.includes(item.selector)))
  const toggleProject = (selector: string) => {
    const selected = selection.projects.includes('*')
      ? configured.map((item) => item.selector)
      : selection.projects
    setProjects(
      selected.includes(selector)
        ? selected.filter((item) => item !== selector)
        : [...selected, selector]
    )
  }
  const toggleProjectGroup = (selectors: string[]) => {
    const selected = selection.projects.includes('*')
      ? configured.map((item) => item.selector)
      : selection.projects
    setProjects(
      selectors.every((selector) => selected.includes(selector))
        ? selected.filter((selector) => !selectors.includes(selector))
        : [...new Set([...selected, ...selectors])]
    )
  }
  const visibleTask = (item: { title: string; source?: string; workflow: { phase: string } }) =>
    item.title.toLowerCase().includes(selection.query.toLowerCase()) &&
    (selection.phase === 'all' || item.workflow.phase === selection.phase) &&
    (selection.source === '*' || item.source === selection.source)
  const taskSources = [
    ...new Set(
      (project ? tasks : overview.rows.map((row) => row.task))
        .map((item) => item.source)
        .filter((item): item is string => Boolean(item))
    )
  ]
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
            { value: 'copies', label: 'Working copies' },
            { value: 'external', label: 'External trackers' }
          ]}
          onSelect={(value) => {
            if (value === 'copies') {
              router.push(`/h/${encodeURIComponent(params.hostId)}`)
            } else if (value === 'external') {
              router.push(`/h/${encodeURIComponent(params.hostId)}/tasks?taskSource=github`)
            }
          }}
        />
      ) : null}
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.content}
        onScrollEndDrag={rememberScroll}
        onMomentumScrollEnd={rememberScroll}
      >
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
            <>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={
                  catalogTruncated ? 'Select all listed projects' : 'Select all projects'
                }
                accessibilityState={{ checked: selectedAll }}
                style={styles.row}
                onPress={() => setProjects(selectedAll ? [] : ['*'])}
              >
                <Text style={styles.text}>
                  {selectedAll ? '☑' : '□'}{' '}
                  {catalogTruncated ? 'Select all listed projects' : 'Select all projects'}
                </Text>
              </Pressable>
              <ProjectTaskCatalog
                projects={projects}
                loading={loading}
                selected={selection.projects}
                onToggle={toggleProject}
                onToggleGroup={toggleProjectGroup}
                onSelect={setProject}
              />
              {projects.some((item) => !item.projectGroupsAvailable) ? (
                <Text style={styles.notice}>
                  This host cannot list project membership. Update the host to see project groups.
                </Text>
              ) : null}
              {!loading && overview.selectedCount === 0 ? (
                <Text style={styles.meta}>Select a project to see its tasks.</Text>
              ) : null}
              {catalogTruncated ? (
                <Text style={styles.notice}>
                  This host lists only its first 256 project roots. Use the desktop on that host to
                  reach the rest.
                </Text>
              ) : null}
              <ProjectTaskFilters
                query={selection.query}
                phase={selection.phase}
                source={selection.source}
                sources={taskSources}
                onQuery={setQuery}
                onPhase={setPhase}
                onSource={setSource}
              />
              {overview.loading ? (
                <Text style={styles.meta}>Loading selected projects…</Text>
              ) : null}
              {overview.errors.map((message) => (
                <Text key={message} style={styles.notice}>
                  {message}
                </Text>
              ))}
              {configured
                .filter(
                  (item) =>
                    selection.projects.includes('*') || selection.projects.includes(item.selector)
                )
                .slice(0, selection.projectLimit)
                .map((item) => {
                  const rows = overview.rows.filter(
                    (row) => row.project === item.selector && visibleTask(row.task)
                  )
                  return rows.length ? (
                    <View key={item.selector} style={styles.section}>
                      <Text style={styles.sectionHeading}>
                        {item.name} · {rows.length}
                      </Text>
                      <ProjectTaskBoard
                        tasks={rows.map((row) => row.task)}
                        loading={overview.loading}
                        onSelect={(next) => setProjectTask(item.selector, next)}
                      />
                    </View>
                  ) : null
                })}
              {overview.selectedCount > selection.projectLimit ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Load more projects"
                  style={styles.row}
                  onPress={loadMoreProjects}
                >
                  <Text style={styles.text}>
                    Load more projects ({selection.projectLimit} of {overview.selectedCount})
                  </Text>
                </Pressable>
              ) : null}
            </>
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
                <ProjectTaskPolicy
                  key={`${params.hostId}:${project}:${executionHostId}`}
                  client={client}
                  connected={state === 'connected' && verified}
                  supported={
                    hostGates?.hostCapabilities.includes(PROJECT_TASK_PROJECT_AGENTS_CAPABILITY) ===
                    true
                  }
                  hostId={params.hostId}
                  worktree={project}
                  executionHostId={executionHostId}
                  projectName={projectName}
                  onChanged={refreshTasks}
                />
                <ProjectTaskFilters
                  query={selection.query}
                  phase={selection.phase}
                  source={selection.source}
                  sources={taskSources}
                  onQuery={setQuery}
                  onPhase={setPhase}
                  onSource={setSource}
                />
                <ProjectTaskBoard
                  tasks={tasks.filter(visibleTask)}
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
