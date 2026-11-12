import React, { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { AutomationEditorDialog } from './AutomationEditorDialog'
import { AutomationsDetailPane } from './AutomationsDetailPane'
import { AutomationsPageSkeleton } from './AutomationsPageSkeleton'
import { getAutomationAuthorityTarget } from './automation-host-client'
import type { AutomationListRow } from './automation-list-row-identity'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import { AutomationsPageTopBar } from './AutomationsPageTopBar'
import type { AutomationsPageController } from './use-automations-page-controller'
import { AutomationRunsDashboardSurface } from './AutomationRunsDashboardSurface'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import { AutomationsPageDeleteDialogs } from './AutomationsPageDeleteDialogs'
import { AutomationsPageListPanel } from './AutomationsPageListPanel'
import { useAutomationsCommandIntegration } from './use-automations-command-integration'
import { AutomationCommandEditorFields } from './AutomationCommandEditorFields'
import { AutomationListCommandRow } from './AutomationListCommandRows'
import { AutomationCommandReports } from './AutomationCommandReports'
import { AutomationsCommandDetailPane } from './AutomationsCommandDetailPane'
export function AutomationsPageSurface({
  controller
}: {
  controller: AutomationsPageController
}): React.JSX.Element {
  const commands = useAutomationsCommandIntegration(controller)
  const commandEditor = commands.executionType === 'command'
  const {
    store,
    local,
    list,
    destination,
    runsDashboard,
    destinationForm,
    setup,
    runPage,
    presentation,
    pageRefresh,
    draftEffects,
    editorActions,
    saveAutomation,
    managementActions,
    runActions,
    externalActions,
    openRunWorkspace
  } = controller
  const {
    projectHostSetups,
    repoMap,
    worktreeMap,
    settings,
    repoForRow,
    worktreeForRow,
    setPendingAutomationRunNavigation
  } = store
  const {
    createOpen,
    editingAutomationId,
    isSaving,
    automationYamlHooksByRepoKey,
    draft,
    setCreateOpen,
    deleteTarget,
    dontAskDeleteAgain,
    deleteConfirmButtonRef,
    setDeleteTarget,
    setDontAskDeleteAgain,
    externalDeleteTarget,
    externalDeleteConfirmButtonRef,
    setExternalDeleteTarget,
    relativeNow,
    externalActionKey,
    activePaneTab,
    setActivePaneTab,
    setSelectedAutomationRunPageId,
    setSelectedAutomationRuns,
    setRunHistoryReloadToken,
    isDetailOpen,
    setIsDetailOpen,
    ownerAction,
    setOwnerAction,
    editorNotice,
    setEditorNotice,
    editorNoticeHost,
    setEditorNoticeHost,
    isLoading,
    pageView,
    setPageView,
    runPageOrigin,
    setRunPageOrigin
  } = local
  const { hostCatalog, hasListItems, selected, selectedRow, selectedExternal } = list
  const selectedAutomationRunPage = setup.selectedAutomationRunPage
  const selectedRunWorktreeMap = useMemo(() => {
    if (!selectedRow) {
      return worktreeMap
    }
    const repo = repoForRow(selectedRow)
    return new Map(
      setup.selectedRuns.flatMap((run) => {
        const worktree = worktreeForRow(selectedRow, repo, run.workspaceId)
        return worktree ? [[worktree.id, worktree] as const] : []
      })
    )
  }, [repoForRow, selectedRow, setup.selectedRuns, worktreeForRow, worktreeMap])
  const runSelectedRowAction = (action: (row: AutomationListRow) => void): void => {
    if (selectedRow) {
      action(selectedRow)
    }
  }
  const recoverOwnerAction = (
    action: AutomationHostRecoveryAction,
    host = ownerAction?.host ?? null
  ): void => {
    setOwnerAction(null)
    hostCatalog.recover(action, host)
    if (action === 'retry') {
      void pageRefresh.refresh()
    }
  }
  const openAutomationRunPage = (run: (typeof setup.selectedRuns)[number]): void => {
    externalActions.openAutomationRunPage(run)
    setRunPageOrigin('automation')
    setPageView('run')
  }
  const showAutomationsList = (): void => {
    commands.setSelected(null)
    setPageView('automations')
    setSelectedAutomationRunPageId(null)
    setIsDetailOpen(false)
    setActivePaneTab('overview')
  }
  const showRunsDashboard = (): void => {
    setPageView('runs')
    setSelectedAutomationRunPageId(null)
    setIsDetailOpen(false)
    setActivePaneTab('overview')
  }
  const showAutomationDetails = (): void => {
    setPageView('automations')
    setSelectedAutomationRunPageId(null)
    setIsDetailOpen(true)
    setActivePaneTab('runs')
  }
  return (
    <main className="relative flex h-full min-h-0 flex-col bg-background pt-5 text-foreground md:pt-6">
      <AutomationsPageTopBar
        pageView={pageView}
        isDetailOpen={isDetailOpen}
        selectedAutomationName={
          isDetailOpen && commands.selected ? commands.selected.definition.name : selected?.name
        }
        runPageOrigin={runPageOrigin}
        ownerNotice={ownerAction?.notice ?? null}
        recoverOwnerAction={recoverOwnerAction}
        dismissOwnerAction={() => setOwnerAction(null)}
        showAutomationsList={showAutomationsList}
        showRunsDashboard={showRunsDashboard}
        showAutomationDetails={showAutomationDetails}
      />
      <AutomationEditorDialog
        open={createOpen || commands.command.editorOpen}
        executionType={commands.executionType}
        onExecutionTypeChange={commands.changeType}
        commandEditor={
          <AutomationCommandEditorFields
            busy={commands.command.busy}
            pendingCreate={commands.command.pending.create !== null}
            draft={commands.command.draft}
            setups={commands.command.setups}
            reportTargets={commands.command.reportTargets}
            error={commands.command.error}
            onDraftChange={(draft) => {
              commands.command.setError(null)
              commands.command.setDraft(draft)
            }}
          />
        }
        isEditing={
          commandEditor ? commands.command.editingId !== null : editingAutomationId !== null
        }
        isSaving={commandEditor ? commands.command.busy : isSaving}
        canSave={
          commandEditor
            ? (commands.command.editingId !== null || commands.createReady) &&
              commands.command.setups.length > 0
            : presentation.canSaveDraft
        }
        createDestination={
          commandEditor ? commands.createDestination : destination.createDestination.control
        }
        editDestination={destinationForm.editDestinationControl}
        notice={editorNotice}
        onNoticeRecover={(action) => {
          const host = editorNoticeHost ?? destination.editorRecoveryHost
          setEditorNotice(null)
          setEditorNoticeHost(null)
          hostCatalog.recover(action, host)
          if (action === 'retry') {
            void pageRefresh.refresh()
          }
        }}
        onNoticeDismiss={() => {
          setEditorNotice(null)
          setEditorNoticeHost(null)
        }}
        repos={destinationForm.dialogRepos}
        projectHostSetups={projectHostSetups}
        automationYamlHooksByRepoKey={automationYamlHooksByRepoKey}
        getAutomationHooksCacheKey={setup.getAutomationHooksCacheKey}
        repoMap={repoMap}
        worktrees={destinationForm.dialogWorktrees}
        settings={settings}
        draft={draft}
        onProjectChange={editorActions.handleProjectChange}
        getRepoHostLabel={presentation.getAutomationRepoHostLabel}
        allowAddProject={
          editingAutomationId !== null
            ? destinationForm.editHostResolution.status === 'ready'
              ? getAutomationAuthorityTarget(destinationForm.editHostResolution.authority).kind ===
                'local'
              : destinationForm.automationDialogTarget.kind === 'local'
            : destinationForm.automationDialogTarget.kind === 'local'
        }
        onOpenChange={(open) => {
          if (!open && commandEditor && commands.command.busy) {
            return
          }
          if (!open) {
            commands.closeEditor()
          }
          setCreateOpen(open)
          if (!open) {
            setEditorNotice(null)
            setEditorNoticeHost(null)
          }
        }}
        onDraftChange={editorActions.handleDraftChange}
        onSetupDecisionTouched={setup.markSetupDecisionTouched}
        onApplyTemplate={draftEffects.applyTemplateToDraft}
        onSave={() => {
          if (commandEditor) {
            void commands.command.save().then((saved) => {
              if (saved) {
                commands.closeEditor()
              }
            })
          } else {
            void saveAutomation()
          }
        }}
      />
      <AutomationsPageDeleteDialogs
        deleteTarget={deleteTarget?.automation ?? null}
        dontAskDeleteAgain={dontAskDeleteAgain}
        deleteConfirmButtonRef={deleteConfirmButtonRef}
        setDeleteTarget={setDeleteTarget}
        setDontAskDeleteAgain={setDontAskDeleteAgain}
        confirmDeleteAutomation={() => void managementActions.confirmDeleteAutomation()}
        externalDeleteTarget={externalDeleteTarget}
        externalDeleteConfirmButtonRef={externalDeleteConfirmButtonRef}
        setExternalDeleteTarget={setExternalDeleteTarget}
        confirmDeleteExternalAutomation={() =>
          void externalActions.confirmDeleteExternalAutomation()
        }
      />
      {commands.command.error &&
        !commands.command.editorOpen &&
        isDetailOpen &&
        commands.selected && (
          <p role="alert" className="px-5 pb-2 text-sm text-destructive">
            {commands.command.error}
          </p>
        )}
      {pageView === 'automations' && !isDetailOpen && commands.catalog.failures.length > 0 && (
        <p role="status" className="px-5 pb-2 text-sm text-muted-foreground">
          {commands.catalog.failures.join(' · ')}
        </p>
      )}
      {isDetailOpen && commands.selected ? (
        <AutomationsCommandDetailPane
          command={commands.command}
          onEdit={commands.edit}
          onBack={showAutomationsList}
        />
      ) : pageView === 'runs' ? (
        <>
          <AutomationRunsDashboardSurface
            rows={list.visibleRows}
            entries={runsDashboard.entries}
            failures={runsDashboard.failures}
            loading={runsDashboard.loading}
            hasMore={runsDashboard.hasMore}
            onLoadMore={runsDashboard.loadMore}
            now={relativeNow}
            onRefresh={() => setRunHistoryReloadToken((token) => token + 1)}
            setPageView={setPageView}
            setRunPageOrigin={setRunPageOrigin}
            selectAutomationRow={list.selectAutomationRow}
            setPendingAutomationRunNavigation={setPendingAutomationRunNavigation}
            setIsDetailOpen={setIsDetailOpen}
          />
          <AutomationCommandReports
            hosts={hostCatalog.entries}
            environmentId={settings?.activeRuntimeEnvironmentId}
          />
        </>
      ) : pageView === 'run' && selectedAutomationRunPage ? (
        <AutomationRunDetailsPage
          automation={selected}
          run={selectedAutomationRunPage}
          relativeNow={relativeNow}
          workspaceDisplay={runPage.selectedAutomationRunPageWorkspaceDisplay}
          viewState={runPage.selectedAutomationRunPageViewState}
          canRerun={runPage.canRerunSelectedAutomationRunPage}
          isRerunPending={runPage.isSelectedAutomationRunPageRerunPending}
          onRerun={() =>
            runSelectedRowAction((row) =>
              runActions.rerunAutomationRun(row, selectedAutomationRunPage)
            )
          }
          onOpenWorkspace={() => openRunWorkspace(selectedAutomationRunPage)}
          onBack={runPageOrigin === 'automation' ? showAutomationDetails : showRunsDashboard}
        />
      ) : pageView === 'run' ? (
        <AutomationsPageSkeleton />
      ) : isLoading && !hasListItems ? (
        <AutomationsPageSkeleton />
      ) : isDetailOpen && (selected || selectedExternal) ? (
        <AutomationsDetailPane
          selected={selected}
          selectedExternal={selectedExternal}
          selectedRuns={setup.selectedRuns}
          selectedRunsNotice={setup.selectedRunsNotice}
          selectedHostEntry={destination.rowRecoveryHost(selectedRow?.key ?? null)}
          recoverSelectedRuns={(action) => {
            hostCatalog.recover(action, destination.rowRecoveryHost(selectedRow?.key ?? null))
            setSelectedAutomationRuns((current) => ({ ...current, notice: null }))
            setRunHistoryReloadToken((token) => token + 1)
          }}
          activePaneTab={activePaneTab}
          relativeNow={relativeNow}
          externalActionKey={externalActionKey}
          selectedRepoDisplayName={
            presentation.selectedRepo?.displayName ??
            translate('auto.components.automations.AutomationsPage.13118faadf', 'Unknown project')
          }
          selectedRepoDefaultBaseRef={presentation.selectedRepo?.worktreeBaseRef ?? null}
          selectedWorkspaceName={
            selected?.workspaceMode === 'new_per_run'
              ? translate(
                  'auto.components.automations.AutomationsPage.cd8397cc32',
                  'New workspace each run'
                )
              : (presentation.selectedWorktree?.displayName ??
                translate(
                  'auto.components.automations.AutomationsPage.missingWorkspace',
                  'Missing workspace'
                ))
          }
          hostLabelById={presentation.hostLabelById}
          selectedRunNowAvailability={presentation.selectedRunNowAvailability}
          worktreeMap={selectedRunWorktreeMap}
          onActivePaneTabChange={setActivePaneTab}
          requestExternalAction={externalActions.requestExternalAction}
          runNow={() => runSelectedRowAction(runActions.runNow)}
          openEditDialog={() => runSelectedRowAction(editorActions.openEditDialog)}
          toggleAutomation={() => runSelectedRowAction(managementActions.toggleAutomation)}
          requestDeleteAutomation={() =>
            runSelectedRowAction(managementActions.requestDeleteAutomation)
          }
          openAutomationRunPage={openAutomationRunPage}
          onBackToList={() => {
            setIsDetailOpen(false)
            setSelectedAutomationRunPageId(null)
            setActivePaneTab('overview')
          }}
        />
      ) : (
        <AutomationsPageListPanel
          controller={controller}
          commandRowCount={commands.rows.length}
          commandRows={commands.rows.map((row) => ({
            kind: 'command',
            id: row.key,
            name: row.definition.name,
            lastRunAt: row.definition.lastRunAt ?? null,
            content: (
              <AutomationListCommandRow row={row} now={relativeNow} onSelect={commands.select} />
            )
          }))}
          onRefreshCommands={commands.catalog.refresh}
          onOpenDetail={() => {
            commands.setSelected(null)
            setIsDetailOpen(true)
          }}
        />
      )}
    </main>
  )
}
