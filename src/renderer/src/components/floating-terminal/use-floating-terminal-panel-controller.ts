import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { createFloatingTerminalPanelDragActions } from './floating-terminal-panel-drag-actions'
import type { FloatingTerminalPanelProps } from './floating-terminal-panel-types'
import { useFloatingTerminalCloseActions } from './use-floating-terminal-close-actions'
import { useFloatingTerminalCreateActions } from './use-floating-terminal-create-actions'
import { useFloatingTerminalFocusLifecycle } from './use-floating-terminal-focus-lifecycle'
import { useFloatingTerminalGlobalShortcutListeners } from './use-floating-terminal-global-shortcut-listeners'
import { useFloatingTerminalGuestBridge } from './use-floating-terminal-guest-bridge'
import { useFloatingTerminalInitialFocusEffects } from './use-floating-terminal-initial-focus-effects'
import { useFloatingTerminalOrchestrationDismissal } from './use-floating-terminal-orchestration-dismissal'
import { useFloatingTerminalOrchestrationVisibility } from './use-floating-terminal-orchestration-visibility'
import { useFloatingTerminalPanelFocusReclaim } from './use-floating-terminal-panel-focus-reclaim'
import { useFloatingTerminalPanelGeometry } from './use-floating-terminal-panel-geometry'
import { useFloatingWorkspaceChromeModel } from './use-floating-workspace-chrome-model'
import { useFloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'
import { useFloatingTerminalPanelMaximize } from './use-floating-terminal-panel-maximize'
import { useFloatingTerminalPanelShortcuts } from './use-floating-terminal-panel-shortcuts'
import { useFloatingTerminalPanelStoreState } from './use-floating-terminal-panel-store-state'
import { useFloatingTerminalShortcutDetails } from './use-floating-terminal-shortcut-details'
import { useAppStore } from '@/store'

export function useFloatingTerminalPanelController({
  open,
  onOpenChange,
  tourInteractionSnapshot
}: FloatingTerminalPanelProps) {
  const storeState = useFloatingTerminalPanelStoreState()
  const shortcutDetails = useFloatingTerminalShortcutDetails()
  const localState = useFloatingTerminalPanelLocalState()
  const items = useFloatingWorkspaceChromeModel()
  const showTasks = useAppStore((s) => s.floatingWorkspaceContent === 'tasks')
  const tasksMounted = useAppStore((s) => s.floatingProjectTasksMounted)
  const setContent = useAppStore((s) => s.setFloatingWorkspaceContent)

  useContextualTour('floating-workspace', open, 'floating_workspace_visible', {
    recordFeatureInteraction: tourInteractionSnapshot?.recordFeatureInteractionForTour ?? false,
    featureInteractionPersisted: tourInteractionSnapshot?.persisted,
    wasFeaturePreviouslyInteracted: tourInteractionSnapshot?.wasPreviouslyInteracted
  })

  const geometry = useFloatingTerminalPanelGeometry({ ...storeState, ...localState })
  useFloatingTerminalInitialFocusEffects({ ...items, ...localState, open: open && !showTasks })
  const orchestrationVisibility = useFloatingTerminalOrchestrationVisibility({
    ...localState,
    open
  })
  const createActions = useFloatingTerminalCreateActions({
    ...storeState,
    ...localState,
    ...items
  })
  const closeActions = useFloatingTerminalCloseActions({
    ...items
  })
  const focusReclaim = useFloatingTerminalPanelFocusReclaim({
    ...storeState,
    ...localState,
    ...items
  })
  const maximize = useFloatingTerminalPanelMaximize({ ...storeState, ...localState, open })
  const shortcuts = useFloatingTerminalPanelShortcuts({
    ...localState,
    ...items,
    ...createActions,
    ...closeActions,
    ...maximize,
    open: open && !showTasks,
    onOpenChange
  })
  useFloatingTerminalGlobalShortcutListeners({
    ...localState,
    ...shortcuts,
    open: open && !showTasks
  })
  useFloatingTerminalGuestBridge({ ...shortcuts, open: open && !showTasks })
  useFloatingTerminalFocusLifecycle({ ...localState, ...items, open: open && !showTasks })
  const dragActions = createFloatingTerminalPanelDragActions({
    ...localState,
    ...geometry,
    ...focusReclaim,
    ...maximize
  })
  const orchestrationDismissal = useFloatingTerminalOrchestrationDismissal(localState)

  return {
    showTasks,
    tasksMounted,
    setContent,
    open,
    onOpenChange,
    ...storeState,
    ...shortcutDetails,
    ...localState,
    ...items,
    ...geometry,
    ...orchestrationVisibility,
    ...createActions,
    ...closeActions,
    ...focusReclaim,
    ...maximize,
    ...shortcuts,
    ...dragActions,
    ...orchestrationDismissal
  }
}
