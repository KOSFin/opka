import { createElement, Fragment, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { Section, Worktree } from '../worktree/workspace-list-types'
import type { ProjectGroup } from '../../../src/shared/project-group-types'

const { rowRenders } = vi.hoisted(() => ({ rowRenders: vi.fn() }))

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  // Renders every row through the list's own renderItem, as a mounted SectionList would.
  SectionList: ({
    sections,
    keyExtractor,
    renderItem,
    renderSectionHeader
  }: {
    sections: Section[]
    keyExtractor: (item: Worktree) => string
    renderItem: (info: { item: Worktree }) => ReactNode
    renderSectionHeader: (info: { section: Section }) => ReactNode
  }) =>
    sections.flatMap((section) => [
      createElement(Fragment, { key: `header:${section.key}` }, renderSectionHeader({ section })),
      ...section.data.map((item) =>
        createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item }))
      )
    ]),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  MoreHorizontal: 'MoreHorizontal',
  Pin: 'Pin'
}))
vi.mock('./MobileProjectGroupManager', () => ({
  MobileProjectGroupManager: (props: { onClose: () => void }) =>
    createElement('GroupManager', props)
}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: vi.fn() }))
vi.mock('../components/AgentSpinner', () => ({ AgentSpinner: () => null }))
vi.mock('../components/MobileRepoIcon', () => ({ MobileRepoIcon: () => null }))
vi.mock('../components/WorktreeAgentList', () => ({ WorktreeAgentList: () => null }))
// The row always renders the glyphs, so each call is one row render.
vi.mock('../components/WorktreeMetaGlyphs', () => ({
  prStateColor: () => '#000000',
  WorktreeMetaGlyphs: () => {
    rowRenders()
    return null
  }
}))
// Off this embedded path; mocked for their native imports.
vi.mock('../components/MobileSearchField', () => ({}))
vi.mock('../components/NewWorkspaceFab', () => ({ FAB_SIZE: 56 }))

import { buildSections } from '../worktree/workspace-list-sections'
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { HostWorkspaceList } from './host-workspace-list'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId: `repo-1::${id}`,
    repoId: 'repo-1',
    repo: 'orca',
    branch: `feature/${id}`,
    displayName: id,
    path: id,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'active',
    ...overrides
  }
}

const noop = () => {}
const stable = { ref: { current: null }, repoById: new Map() }

function listProps(
  worktrees: Worktree[],
  options: { hostId?: string; sections?: Section[]; projectGroups?: ProjectGroup[] } = {}
) {
  // Each poll re-parses the payload, so rows are fresh objects even when nothing changed.
  const polled: Worktree[] = JSON.parse(JSON.stringify(worktrees))
  const sections =
    options.sections ??
    buildSections(polled, 'name', NO_WORKSPACE_ROW_FILTERS, '', 'none', new Set())
  const controller = {
    actions: { openWorktreeSession: noop, openNewWorktreeModal: noop },
    activeWorktreeScroll: { sectionListRef: stable.ref, onScrollToIndexFailed: noop },
    catalog: { refreshing: false, onRefresh: noop },
    connState: 'connected',
    hostId: options.hostId ?? 'host-a',
    collapsedGroups: new Set(),
    displayWorktrees: polled,
    embedded: true,
    insets: { bottom: 0 },
    isReadOnly: false,
    now: 1_000,
    reconnectAttempts: 0,
    relayRecovery: { pairingRejected: false },
    sectionsResult: { rawSections: sections, sections, repoById: stable.repoById },
    settings: {
      activeFilterCount: 0,
      toggleWorktreeLineage: noop,
      pendingViewChanges: { pending: [], stale: false }
    },
    state: {
      actionError: '',
      hostProjectGroups: options.projectGroups ?? [],
      setActionTarget: noop,
      view: { ...INITIAL_MOBILE_VIEW, groupBy: 'none' },
      search: '',
      showSearch: false,
      worktreesLoaded: true
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list reads only the controller fields above on this connected, embedded, error-free path.
  return { controller } as unknown as Parameters<typeof HostWorkspaceList>[0]
}

describe('host list rows across polls', () => {
  it('drops an open group sheet on A→B→A and ignores the old close callback', () => {
    const group: ProjectGroup = {
      id: 'group-a',
      name: 'Group A',
      parentPath: null,
      connectionId: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const sections: Section[] = [
      {
        key: 'project-group:local:group-a',
        title: 'Group A',
        data: [],
        projectGroupHeader: true,
        projectGroupId: group.id,
        projectGroupHostId: 'local'
      }
    ]
    const props = (hostId: string) => listProps([], { hostId, sections, projectGroups: [group] })
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(createElement(HostWorkspaceList, props('host-a')))
    })
    const open = () => {
      const button = tree.root.findByProps({ accessibilityLabel: 'Manage project Group A' })
      act(() => button.props.onPress({ stopPropagation: noop }))
    }
    open()
    const managerRows = () => tree.root.findAll((node) => String(node.type) === 'GroupManager')
    const oldClose: unknown = managerRows()[0]?.props.onClose
    expect(typeof oldClose).toBe('function')
    act(() => tree.update(createElement(HostWorkspaceList, props('host-b'))))
    expect(managerRows()).toHaveLength(0)
    act(() => tree.update(createElement(HostWorkspaceList, props('host-a'))))
    expect(managerRows()).toHaveLength(0)
    open()
    if (typeof oldClose !== 'function') {
      throw new Error('Expected the previous group sheet to expose a close callback')
    }
    act(() => oldClose())
    expect(managerRows()).toHaveLength(1)
    act(() => tree.unmount())
  })
  it('re-renders only the row whose worktree changed', () => {
    const rows = [worktree('a'), worktree('b'), worktree('c')]
    let tree: ReactTestRenderer | null = null
    act(() => {
      tree = create(createElement(HostWorkspaceList, listProps(rows)))
    })
    rowRenders.mockClear()

    const changed = [rows[0]!, { ...rows[1]!, branch: 'feature/b-renamed' }, rows[2]!]
    act(() => tree!.update(createElement(HostWorkspaceList, listProps(changed))))

    expect(rowRenders).toHaveBeenCalledTimes(1)
    act(() => tree!.unmount())
  })
  it('re-renders only the workspace whose child roster changed', () => {
    const row = worktree('a', {
      agents: [
        {
          paneKey: 'parent',
          parentPaneKey: null,
          state: 'working',
          agentType: 'codex',
          prompt: '',
          taskTitle: null,
          displayName: null,
          lastAssistantMessage: null,
          toolName: null,
          toolInput: null,
          interrupted: false,
          stateStartedAt: 1,
          updatedAt: 1,
          subagents: [{ id: 'child', state: 'working', startedAt: 1 }]
        }
      ]
    })
    let tree: ReactTestRenderer | null = null
    act(() => {
      tree = create(createElement(HostWorkspaceList, listProps([row, worktree('b')])))
    })
    rowRenders.mockClear()
    const changed = {
      ...row,
      agents: [
        {
          ...row.agents![0]!,
          subagents: [{ id: 'child', state: 'waiting' as const, startedAt: 1 }]
        }
      ]
    }
    act(() => tree!.update(createElement(HostWorkspaceList, listProps([changed, worktree('b')]))))
    expect(rowRenders).toHaveBeenCalledTimes(1)
    act(() => tree!.unmount())
  })
})
