import { beforeEach, describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  isAccountRestartReady,
  selectReadyAccountRestartPtyIds
} from './pane-account-restart-readiness'

const LEAF = '11111111-1111-4111-8111-111111111111'

function status(tabId: string, state: AgentStatusEntry['state']): AgentStatusEntry {
  const paneKey = makePaneKey(tabId, LEAF)
  return {
    paneKey,
    tabId,
    state,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'claude'
  }
}

function setStatuses(...entries: AgentStatusEntry[]): void {
  useAppStore.setState({
    agentStatusByPaneKey: Object.fromEntries(entries.map((entry) => [entry.paneKey, entry]))
  })
}

const ready = (): string[] => selectReadyAccountRestartPtyIds(useAppStore.getState(), 'tab-1')

describe('selectReadyAccountRestartPtyIds', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      terminalLayoutsByTabId: Object.fromEntries(
        ['tab-1', 'tab-2'].map((tabId) => [
          tabId,
          {
            root: { type: 'leaf', leafId: LEAF },
            activeLeafId: LEAF,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF]: `${tabId}-pty` }
          }
        ])
      )
    })
  })

  it("holds this tab's Claude restart until its turn ends", () => {
    setStatuses(status('tab-1', 'working'))
    useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')
    expect(ready()).toEqual([])

    setStatuses(status('tab-1', 'done'))
    expect(ready()).toEqual(['tab-1-pty'])
  })

  it("gives an equal result when only another tab's status changes", () => {
    setStatuses(status('tab-1', 'working'), status('tab-2', 'working'))
    useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty', 'tab-2-pty'], 'claude')
    const before = ready()

    setStatuses(status('tab-1', 'working'), status('tab-2', 'done'))

    expect(shallow(before, ready())).toBe(true)
  })

  it('treats a Codex restart as ready at once', () => {
    useAppStore.getState().queuePaneAccountRestarts(['codex-pty'], 'codex')
    expect(ready()).toEqual(['codex-pty'])
  })

  it.each(['working', 'blocked', 'waiting', 'unverifiable'] as const)(
    'holds a completed Claude parent while its legacy child is %s',
    (state) => {
      const parent = status('tab-1', 'done')
      parent.subagents = [{ id: 'child', state, startedAt: 1 }]
      setStatuses(parent)
      useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')
      expect(ready()).toEqual([])
      expect(isAccountRestartReady(useAppStore.getState(), 'tab-1', LEAF, 'tab-1-pty')).toBe(false)

      setStatuses({ ...parent, subagents: [] })
      expect(ready()).toEqual(['tab-1-pty'])
    }
  )

  it.each(['working', 'monitoring', 'blocked', 'waiting', 'unverifiable'] as const)(
    'holds a completed Claude parent while host child work is %s',
    (state) => {
      const parent = status('tab-1', 'done')
      parent.children = [
        {
          id: 'child',
          kind: 'agent',
          state,
          membership: 'live',
          firstObservedAt: 1,
          observedAt: 1,
          stoppable: true,
          invocation: { invocationId: 'invocation', generation: 1 }
        }
      ]
      setStatuses(parent)
      useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')
      expect(ready()).toEqual([])
      expect(isAccountRestartReady(useAppStore.getState(), 'tab-1', LEAF, 'tab-1-pty')).toBe(false)

      setStatuses({
        ...parent,
        children: parent.children.map((child) => ({
          ...child,
          membership: 'settled',
          state: 'done'
        }))
      })
      expect(ready()).toEqual(['tab-1-pty'])
    }
  )

  it('uses an authoritative empty child list instead of a legacy roster', () => {
    setStatuses({
      ...status('tab-1', 'done'),
      children: [],
      subagents: [{ id: 'legacy-child', state: 'working', startedAt: 1 }]
    })
    useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')
    expect(ready()).toEqual(['tab-1-pty'])
  })

  it('holds a Claude restart until live status confirms the turn ended', () => {
    useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')
    expect(ready()).toEqual([])

    setStatuses({ ...status('tab-1', 'done'), restoredUnconfirmed: true })
    expect(ready()).toEqual([])
    setStatuses({ ...status('tab-1', 'done'), agentType: 'codex' })
    expect(ready()).toEqual([])

    setStatuses(status('tab-1', 'done'))
    expect(ready()).toEqual(['tab-1-pty'])
  })
})
