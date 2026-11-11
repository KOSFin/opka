import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Text, View, type ListRenderItem } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { useForceReconnect } from '../transport/host-client-hooks'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { connectionRetryAction } from '../transport/connection-retry-action'
import { getWorktreeLabel } from '../session/worktree-label'
import {
  flattenDirectoryCache,
  getDirectoryCacheState,
  type DirectoryCache,
  type FileExplorerRow,
  type MobileDirEntry
} from './file-tree'
import type { RpcFailure } from '../transport/types'
import { colors } from '../theme/mobile-theme'
import {
  beginDirectoryLoad,
  createDirectoryLoadRevisions,
  isCurrentDirectoryLoad,
  resetDirectoryLoadRevisions,
  type DirectoryLoadRevisions
} from './directory-load-revisions'
import { directoryCacheFromFileList } from './file-list-fallback'
import { fileDirectoryPageRead, legacyFileListRead } from './mobile-file-explorer-operations'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'
import { MobileFileExplorerRow } from './mobile-file-explorer-row'
import { MobileFileExplorerHeader } from './MobileFileExplorerHeader'
import { useMobileFileExplorerNavigation } from './use-mobile-file-explorer-navigation'
import { navigateToMobileFilePreview } from './mobile-file-preview-navigation'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'

type MobileFileExplorerPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  embedded?: boolean
  onRequestClose?: () => void
}

export function MobileFileExplorerPanel(props: MobileFileExplorerPanelProps) {
  return (
    <MobileFileExplorerPanelContent
      key={JSON.stringify([props.hostId, props.worktreeId])}
      {...props}
    />
  )
}

function MobileFileExplorerPanelContent(props: MobileFileExplorerPanelProps) {
  const { hostId, worktreeId, name, embedded, onRequestClose } = props
  const router = useWorkspaceRouteHandoff()
  const { client, state: connState } = useWorkspaceClient(hostId)
  const forceReconnect = useForceReconnect()
  const scopeRef = useRef('')
  const scope = `${hostId}:${worktreeId}`
  scopeRef.current = scope
  const directoryLoadRevisionsRef = useRef<DirectoryLoadRevisions>(createDirectoryLoadRevisions())
  const pendingDirectoryRetriesRef = useRef<Set<string>>(new Set())
  const directoryCacheRef = useRef<DirectoryCache>({})
  const [directoryCache, setDirectoryCache] = useState<DirectoryCache>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [legacyListTruncated, setLegacyListTruncated] = useState(false)
  const {
    displayRoot,
    displayRootRef,
    history: navigation,
    navigateTo,
    goBack,
    goForward,
    goUp
  } = useMobileFileExplorerNavigation()
  const worktreeLabel = getWorktreeLabel(name, worktreeId)

  const loadDirectory = useCallback(
    async (relativePath: string, cursor?: string) => {
      const scope = scopeRef.current
      const requestedDisplayRoot = displayRootRef.current
      const loadToken = beginDirectoryLoad(directoryLoadRevisionsRef.current, scope, relativePath)
      const rootLoad = relativePath === ''

      if (!client || connState !== 'connected') {
        const message =
          connState === 'connected' ? 'Connecting to desktop...' : 'Waiting for desktop...'
        if (rootLoad) {
          const hasLoadedRoot =
            (getDirectoryCacheState(directoryCacheRef.current, '')?.entries.length ?? 0) > 0
          setLoading(false)
          // Why: transient reconnects should not blank an already browsable tree.
          setError(hasLoadedRoot ? null : message)
        } else {
          setDirectoryCache((prev) => ({
            ...prev,
            [relativePath]: {
              entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
              error: message
            }
          }))
        }
        return
      }

      const hadLoadedRoot =
        rootLoad && (getDirectoryCacheState(directoryCacheRef.current, '')?.entries.length ?? 0) > 0
      if (rootLoad) {
        // Why: a reconnect refresh must not blank an already browsable tree —
        // the full-screen spinner unmounts the list and resets scroll.
        if (!hadLoadedRoot) {
          setLoading(true)
        }
        setError(null)
      }
      setDirectoryCache((prev) => ({
        ...prev,
        [relativePath]: {
          entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
          nextCursor: getDirectoryCacheState(prev, relativePath)?.nextCursor,
          loading: true
        }
      }))

      try {
        const pageResponse = await fileDirectoryPageRead.request(client, {
          worktree: `id:${worktreeId}`,
          relativePath,
          ...(cursor ? { cursor } : {})
        })
        const page = fileDirectoryPageRead.interpret(pageResponse)
        let entries: MobileDirEntry[]
        let nextCursor: string | null = null
        if (page.accepted) {
          entries = page.value.entries
          nextCursor = page.value.nextCursor
        } else {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this policy skips only a refusal, so an unaccepted reply is a failure envelope.
          const pageRefusal = (pageResponse as RpcFailure).error
          if (pageRefusal?.code !== 'method_not_found' || cursor) {
            throw new Error(pageRefusal?.message || 'Unable to load files')
          }
          if (!rootLoad) {
            throw new Error('Directory paging requires a newer Orca execution host')
          }
          const legacyReply = await legacyFileListRead.request(client, {
            worktree: `id:${worktreeId}`
          })
          const legacy = legacyFileListRead.interpret(legacyReply)
          if (!legacy.accepted) {
            throw new Error(
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a skipped result is a failure envelope.
              (legacyReply as RpcFailure).error?.message || 'Unable to load files'
            )
          }
          if (
            !isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken)
          ) {
            return
          }
          setDirectoryCache(directoryCacheFromFileList(legacy.value.files))
          setLegacyListTruncated(legacy.value.truncated)
          return
        }
        if (
          !isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken) ||
          (cursor && displayRootRef.current !== requestedDisplayRoot)
        ) {
          return
        }
        if (rootLoad) {
          setLegacyListTruncated(false)
        }
        setDirectoryCache((prev) => {
          const previous = getDirectoryCacheState(prev, relativePath)
          if (
            cursor &&
            (previous?.nextCursor !== cursor || displayRootRef.current !== requestedDisplayRoot)
          ) {
            return prev
          }
          return {
            ...prev,
            [relativePath]: {
              entries: cursor ? [...(previous?.entries ?? []), ...entries] : entries,
              nextCursor
            }
          }
        })
      } catch (err) {
        if (
          !isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken) ||
          (cursor && displayRootRef.current !== requestedDisplayRoot)
        ) {
          return
        }
        const message = err instanceof Error ? err.message : 'Unable to load files'
        if (rootLoad) {
          // Why: a failed background refresh keeps the cached tree browsable;
          // only a cold load surfaces the full-screen error.
          setError(hadLoadedRoot ? null : message)
        } else {
          setDirectoryCache((prev) => ({
            ...prev,
            [relativePath]: {
              entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
              error: message
            }
          }))
        }
      } finally {
        if (
          rootLoad &&
          isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken)
        ) {
          setLoading(false)
        }
      }
    },
    [client, connState, worktreeId]
  )

  useEffect(() => {
    scopeRef.current = scope
    resetDirectoryLoadRevisions(directoryLoadRevisionsRef.current)
    pendingDirectoryRetriesRef.current.clear()
    directoryCacheRef.current = {}
    setDirectoryCache({})
    setExpanded(new Set())
    setLoading(true)
    setError(null)
    setLegacyListTruncated(false)
  }, [scope])

  useEffect(() => {
    directoryCacheRef.current = directoryCache
  }, [directoryCache])

  useEffect(() => {
    void loadDirectory('')
  }, [hostId, loadDirectory])

  useEffect(() => {
    if (connState !== 'connected' || pendingDirectoryRetriesRef.current.size === 0) {
      return
    }
    const pending = [...pendingDirectoryRetriesRef.current]
    pendingDirectoryRetriesRef.current.clear()
    for (const relativePath of pending) {
      void loadDirectory(relativePath)
    }
  }, [connState, loadDirectory])

  const rows = useMemo(
    () => flattenDirectoryCache(directoryCache, expanded, displayRoot),
    [directoryCache, expanded, displayRoot]
  )

  useEffect(() => {
    if (displayRoot && !getDirectoryCacheState(directoryCacheRef.current, displayRoot)) {
      void loadDirectory(displayRoot)
    }
  }, [displayRoot, loadDirectory])

  const loadMore = useCallback(
    (relativePath: string) => {
      const state = getDirectoryCacheState(directoryCacheRef.current, relativePath)
      if (state?.nextCursor && !state.loading) {
        void loadDirectory(relativePath, state.nextCursor)
      }
    },
    [loadDirectory]
  )

  const toggleDirectory = useCallback(
    (relativePath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(relativePath)) {
          next.delete(relativePath)
        } else {
          next.add(relativePath)
        }
        return next
      })
      const state = getDirectoryCacheState(directoryCache, relativePath)
      if (!expanded.has(relativePath) && !state?.loading && (!state?.entries || state.error)) {
        void loadDirectory(relativePath)
      }
    },
    [directoryCache, expanded, loadDirectory]
  )

  const retryDirectory = useCallback(
    (relativePath: string) => {
      if (connState !== 'connected' && hostId) {
        // Still worth a tap on the page, where nothing re-dials: the queued read runs when the
        // shell's client reconnects on its own.
        pendingDirectoryRetriesRef.current.add(relativePath)
        void forceReconnect?.(hostId)
        return
      }
      void loadDirectory(relativePath)
    },
    [connState, forceReconnect, hostId, loadDirectory]
  )

  const previewFile = useCallback(
    (relativePath: string, displayName: string) => {
      navigateToMobileFilePreview(
        router,
        {
          hostId,
          worktreeId,
          relativePath,
          name: displayName,
          worktreeName: name
        },
        { embedded, onRequestClose }
      )
    },
    [embedded, hostId, name, onRequestClose, router, worktreeId]
  )

  const renderItem: ListRenderItem<FileExplorerRow> = ({ item }) => {
    return (
      <MobileFileExplorerRow
        item={item}
        expanded={expanded}
        onPreviewFile={previewFile}
        onRetryDirectory={retryDirectory}
        onToggleDirectory={toggleDirectory}
        onLoadMore={loadMore}
        onOpenHere={navigateTo}
      />
    )
  }

  const headerBar = (
    <MobileFileExplorerHeader
      embedded={embedded}
      worktreeLabel={worktreeLabel}
      legacyListTruncated={legacyListTruncated}
      displayRoot={displayRoot}
      canGoBack={navigation.back.length > 0}
      canGoForward={navigation.forward.length > 0}
      onClose={onRequestClose}
      onBackToSession={() => router.back()}
      onBack={goBack}
      onForward={goForward}
      onUp={goUp}
      onNavigate={navigateTo}
    />
  )

  // Why: while disconnected, re-sending the request is useless — revive the parked transport
  // instead (issue #5049); loadDirectory re-runs via its effect once the new client connects.
  const rootRetry = connectionRetryAction({
    hostId,
    needsReconnect: connState !== 'connected',
    forceReconnect,
    reload: () => void loadDirectory('')
  })
  const body = loading ? (
    <View style={styles.state}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : error ? (
    <MobileLoadErrorState message={error} onRetry={rootRetry} />
  ) : getDirectoryCacheState(directoryCache, displayRoot)?.error && rows.length === 0 ? (
    <MobileLoadErrorState
      message={
        getDirectoryCacheState(directoryCache, displayRoot)?.error ?? 'Unable to load folder'
      }
      onRetry={() => retryDirectory(displayRoot)}
    />
  ) : rows.length === 0 ? (
    <View style={styles.state}>
      <Text style={styles.emptyText}>No files found</Text>
    </View>
  ) : (
    <FlatList
      data={rows}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      style={styles.list}
      ListFooterComponent={
        getDirectoryCacheState(directoryCache, displayRoot)?.error ? (
          <Text style={styles.inlineErrorText}>
            {getDirectoryCacheState(directoryCache, displayRoot)?.error}
          </Text>
        ) : null
      }
    />
  )

  // Embedded: the dock column owns safe-area/layout, so render a plain View and
  // a non-inset header. Full-screen: keep the SafeAreaView top inset + chrome.
  return (
    <View style={styles.container}>
      {embedded ? (
        <View style={styles.header}>{headerBar}</View>
      ) : (
        <SafeAreaView style={styles.header} edges={['top']}>
          {headerBar}
        </SafeAreaView>
      )}
      {body}
    </View>
  )
}
