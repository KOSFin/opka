import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileFileExplorerPanel } from './MobileFileExplorerPanel'
import type { MobileDirEntry } from './file-tree'
import type { RpcResponse } from '../transport/types'

type MockClient = {
  sendRequest: ReturnType<typeof vi.fn>
}

const mockTransport = vi.hoisted(
  (): {
    client: MockClient | null
    connectionState: string
    forceReconnect: ReturnType<typeof vi.fn> | null
  } => ({
    client: null,
    connectionState: 'connected',
    forceReconnect: vi.fn()
  })
)

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: (props: {
      data: unknown[]
      keyExtractor: (item: unknown, index: number) => string
      renderItem: (info: {
        item: unknown
        index: number
        separators: Record<string, never>
      }) => ReactNode
    }) =>
      React.createElement(
        'FlatList',
        props,
        props.data.map((item, index) =>
          React.createElement(
            'FlatListItem',
            { key: props.keyExtractor(item, index) },
            props.renderItem({ item, index, separators: {} })
          )
        )
      ),
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1
    },
    Text: 'Text',
    View: 'View'
  }
})

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView'
}))

vi.mock('expo-router', () => ({
  useRouter: () => ({
    back: vi.fn(),
    push: vi.fn()
  })
}))

vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  ChevronUp: 'ChevronUp',
  File: 'File',
  FileText: 'FileText',
  Folder: 'Folder',
  Image: 'Image',
  X: 'X'
}))

vi.mock('../platform/haptics', () => ({
  triggerSelection: vi.fn()
}))

vi.mock('../transport/host-client-hooks', () => ({
  useForceReconnect: () => mockTransport.forceReconnect,
  useHostClient: () => ({
    client: mockTransport.client,
    state: mockTransport.connectionState
  })
}))

function entry(name: string, isDirectory = false): MobileDirEntry {
  return { name, isDirectory }
}

function ok(result: MobileDirEntry[]): RpcResponse {
  return {
    id: 'response-id',
    ok: true,
    result: { entries: result, nextCursor: null },
    _meta: { runtimeId: 'runtime-id' }
  }
}

function createMockClient(entriesByPath: Record<string, MobileDirEntry[]>): MockClient {
  return {
    sendRequest: vi.fn(async (_method: string, params: { relativePath: string }) => {
      return ok(entriesByPath[params.relativePath] ?? [])
    })
  }
}

async function renderExplorer(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(
      createElement(MobileFileExplorerPanel, {
        hostId: 'host-a',
        worktreeId: 'worktree-a',
        name: 'Example Worktree',
        embedded: true
      })
    )
  })
  if (!renderer) {
    throw new Error('MobileFileExplorerPanel did not render')
  }
  return renderer
}

async function updateExplorer(
  renderer: ReactTestRenderer,
  worktreeId = 'worktree-a',
  hostId = 'host-a'
): Promise<void> {
  await act(async () => {
    renderer.update(
      createElement(MobileFileExplorerPanel, {
        hostId,
        worktreeId,
        name: 'Example Worktree',
        embedded: true
      })
    )
  })
}

async function pressByLabel(
  renderer: ReactTestRenderer,
  accessibilityLabel: string
): Promise<void> {
  const pressable = renderer.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find((node) => node.props.accessibilityLabel === accessibilityLabel)
  if (!pressable) {
    throw new Error(`Unable to find pressable: ${accessibilityLabel}`)
  }
  await act(async () => {
    pressable.props.onPress()
  })
}

function renderedText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => String(node.type) === 'Text')
    .flatMap((node) => node.props.children)
    .join(' ')
}

describe('MobileFileExplorerPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    mockTransport.client = null
    mockTransport.connectionState = 'connected'
    mockTransport.forceReconnect = vi.fn()
  })

  it('loads directories lazily and reuses cached children when reopened', async () => {
    const client = createMockClient({
      '': [entry('src', true), entry('README.md')],
      src: [entry('app.ts'), entry('components', true)]
    })
    mockTransport.client = client

    const renderer = await renderExplorer()

    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    expect(client.sendRequest).toHaveBeenLastCalledWith('files.readDirPage', {
      worktree: 'id:worktree-a',
      relativePath: ''
    })

    await pressByLabel(renderer, 'Open folder src')
    await vi.waitFor(() => expect(client.sendRequest).toHaveBeenCalledTimes(2))
    expect(client.sendRequest).toHaveBeenLastCalledWith('files.readDirPage', {
      worktree: 'id:worktree-a',
      relativePath: 'src'
    })
    expect(renderedText(renderer)).toContain('app.ts')

    await pressByLabel(renderer, 'Open folder src')
    await pressByLabel(renderer, 'Open folder src')

    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('loads a second page only on request and appends it in the same folder', async () => {
    const client: MockClient = {
      sendRequest: vi.fn(
        async (_method: string, params: { cursor?: string }): Promise<RpcResponse> => ({
          id: 'response-id',
          ok: true,
          result: params.cursor
            ? { entries: [entry('b.txt')], nextCursor: null }
            : { entries: [entry('a.txt')], nextCursor: 'cursor-one' },
          _meta: { runtimeId: 'runtime-id' }
        })
      )
    }
    mockTransport.client = client
    const renderer = await renderExplorer()
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    expect(renderedText(renderer)).toContain('a.txt')
    await pressByLabel(renderer, 'Load more files in workspace root')
    expect(client.sendRequest).toHaveBeenLastCalledWith('files.readDirPage', {
      worktree: 'id:worktree-a',
      relativePath: '',
      cursor: 'cursor-one'
    })
    expect(renderedText(renderer)).toContain('b.txt')
  })

  it('opens a folder here and navigates up, back and forward without changing workspace', async () => {
    const client = createMockClient({
      '': [entry('src', true), entry('README.md')],
      src: [entry('app.ts')]
    })
    mockTransport.client = client
    const renderer = await renderExplorer()
    const folder = renderer.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => node.props.accessibilityLabel === 'Open folder src')
    await act(async () => {
      folder?.props.onLongPress()
    })
    await vi.waitFor(() => expect(renderedText(renderer)).toContain('app.ts'))
    expect(renderedText(renderer)).not.toContain('README.md')
    expect(renderedText(renderer)).toContain('terminal cwd unchanged')
    await pressByLabel(renderer, 'Explorer up')
    expect(renderedText(renderer)).toContain('README.md')
    await pressByLabel(renderer, 'Explorer back')
    expect(renderedText(renderer)).toContain('app.ts')
    await pressByLabel(renderer, 'Explorer forward')
    expect(renderedText(renderer)).toContain('README.md')
    expect(client.sendRequest).toHaveBeenCalledWith('files.readDirPage', {
      worktree: 'id:worktree-a',
      relativePath: 'src'
    })
  })

  it('keeps an old folder reply out of a newly selected workspace', async () => {
    let finishOldRead: (reply: RpcResponse) => void = () => {
      throw new Error('Old read did not start')
    }
    const oldRead = new Promise<RpcResponse>((resolve) => {
      finishOldRead = resolve
    })
    const client: MockClient = {
      sendRequest: vi.fn(
        async (_method: string, params: { worktree: string; relativePath: string }) => {
          if (params.worktree === 'id:worktree-a' && params.relativePath === 'src') {
            return oldRead
          }
          return ok(params.worktree === 'id:worktree-b' ? [entry('new.txt')] : [entry('src', true)])
        }
      )
    }
    mockTransport.client = client
    const renderer = await renderExplorer()
    const folder = renderer.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => node.props.accessibilityLabel === 'Open folder src')
    await act(async () => {
      folder?.props.onLongPress()
    })
    await vi.waitFor(() => expect(client.sendRequest).toHaveBeenCalledTimes(2))

    await updateExplorer(renderer, 'worktree-b')
    expect(renderedText(renderer)).toContain('new.txt')
    await act(async () => {
      finishOldRead(ok([entry('stale.txt')]))
    })
    expect(renderedText(renderer)).toContain('new.txt')
    expect(renderedText(renderer)).not.toContain('stale.txt')
  })

  it('resets the view for a new owner even when the workspace ID and path match', async () => {
    let finishOldRead: (reply: RpcResponse) => void = () => {
      throw new Error('Old read did not start')
    }
    const oldRead = new Promise<RpcResponse>((resolve) => {
      finishOldRead = resolve
    })
    const clientA: MockClient = {
      sendRequest: vi.fn(async (_method: string, params: { relativePath: string }) =>
        params.relativePath === 'src' ? oldRead : ok([entry('src', true)])
      )
    }
    const clientB = createMockClient({ '': [entry('new-owner.txt')] })
    mockTransport.client = clientA
    const renderer = await renderExplorer()
    const oldFolder = renderer.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => node.props.accessibilityLabel === 'Open folder src')
    const staleAction: (() => void) | undefined = oldFolder?.props.onLongPress
    expect(staleAction).toBeTypeOf('function')
    await act(async () => {
      staleAction?.()
    })
    await vi.waitFor(() => expect(clientA.sendRequest).toHaveBeenCalledTimes(2))

    mockTransport.client = clientB
    await updateExplorer(renderer, 'worktree-a', 'host-b')
    expect(renderedText(renderer)).toContain('new-owner.txt')
    expect(renderedText(renderer)).not.toContain('Explorer view only')
    await act(async () => {
      finishOldRead(ok([entry('stale-owner.txt')]))
      staleAction?.()
    })
    expect(renderedText(renderer)).toContain('new-owner.txt')
    expect(renderedText(renderer)).not.toContain('stale-owner.txt')
  })

  it('keeps the loaded tree visible during a transient disconnect', async () => {
    const client = createMockClient({
      '': [entry('src', true), entry('README.md')]
    })
    mockTransport.client = client

    const renderer = await renderExplorer()
    expect(renderedText(renderer)).toContain('src')

    mockTransport.client = null
    mockTransport.connectionState = 'disconnected'
    await updateExplorer(renderer)

    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')
    expect(renderedText(renderer)).not.toContain('Waiting for desktop...')
  })

  it('refreshes the root in the background after reconnect without blanking the tree', async () => {
    const client = createMockClient({
      '': [entry('src', true), entry('README.md')]
    })
    mockTransport.client = client

    const renderer = await renderExplorer()
    expect(renderedText(renderer)).toContain('README.md')

    mockTransport.client = null
    mockTransport.connectionState = 'disconnected'
    await updateExplorer(renderer)

    let resolveReload: ((response: RpcResponse) => void) | undefined
    const reconnectedClient: MockClient = {
      sendRequest: vi.fn(
        () =>
          new Promise<RpcResponse>((resolve) => {
            resolveReload = resolve
          })
      )
    }
    mockTransport.client = reconnectedClient
    mockTransport.connectionState = 'connected'
    await updateExplorer(renderer)

    expect(reconnectedClient.sendRequest).toHaveBeenCalledTimes(1)
    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')

    await act(async () => {
      resolveReload?.(ok([entry('src', true), entry('README.md'), entry('CHANGELOG.md')]))
    })
    expect(renderedText(renderer)).toContain('CHANGELOG.md')
  })

  it('keeps the cached tree when a post-reconnect root refresh fails', async () => {
    const client = createMockClient({
      '': [entry('src', true), entry('README.md')]
    })
    mockTransport.client = client

    const renderer = await renderExplorer()
    expect(renderedText(renderer)).toContain('README.md')

    mockTransport.client = null
    mockTransport.connectionState = 'disconnected'
    await updateExplorer(renderer)

    const failingClient: MockClient = {
      sendRequest: vi.fn(async () => {
        throw new Error('refresh failed')
      })
    }
    mockTransport.client = failingClient
    mockTransport.connectionState = 'connected'
    await updateExplorer(renderer)

    expect(failingClient.sendRequest).toHaveBeenCalledTimes(1)
    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')
    expect(renderedText(renderer)).not.toContain('refresh failed')
  })

  it('falls back to the capped files.list against desktops without files.readDir', async () => {
    const legacyClient: MockClient = {
      sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
        if (method === 'files.readDirPage') {
          return {
            id: 'response-id',
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
            _meta: { runtimeId: 'runtime-id' }
          }
        }
        return {
          id: 'response-id',
          ok: true,
          result: {
            files: [
              { relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' },
              { relativePath: 'README.md', basename: 'README.md', kind: 'text' }
            ],
            totalCount: 2,
            truncated: false
          },
          _meta: { runtimeId: 'runtime-id' }
        }
      })
    }
    mockTransport.client = legacyClient

    const renderer = await renderExplorer()

    expect(legacyClient.sendRequest).toHaveBeenCalledWith('files.list', {
      worktree: 'id:worktree-a'
    })
    expect(legacyClient.sendRequest).not.toHaveBeenCalledWith('files.readDir', expect.anything())
    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')

    await pressByLabel(renderer, 'Open folder src')
    expect(renderedText(renderer)).toContain('app.ts')
    // The capped list supplies cached children without another directory read.
    expect(legacyClient.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('surfaces the legacy cap note when the files.list fallback is truncated', async () => {
    const legacyClient: MockClient = {
      sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
        if (method === 'files.readDirPage') {
          return {
            id: 'response-id',
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
            _meta: { runtimeId: 'runtime-id' }
          }
        }
        return {
          id: 'response-id',
          ok: true,
          result: {
            files: [{ relativePath: 'README.md', basename: 'README.md', kind: 'text' }],
            totalCount: 6000,
            truncated: true
          },
          _meta: { runtimeId: 'runtime-id' }
        }
      })
    }
    mockTransport.client = legacyClient

    const renderer = await renderExplorer()

    expect(renderedText(renderer)).toContain('README.md')
    expect(renderedText(renderer)).toContain('Showing first 5000')
  })

  it('reports the files.list failure when the fallback itself fails', async () => {
    const legacyClient: MockClient = {
      sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
        if (method === 'files.readDirPage') {
          return {
            id: 'response-id',
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
            _meta: { runtimeId: 'runtime-id' }
          }
        }
        return {
          id: 'response-id',
          ok: false,
          error: { code: 'internal', message: 'legacy list failed' },
          _meta: { runtimeId: 'runtime-id' }
        }
      })
    }
    mockTransport.client = legacyClient

    const renderer = await renderExplorer()

    expect(renderedText(renderer)).toContain('legacy list failed')
    expect(renderedText(renderer)).not.toContain('not available to mobile clients')
  })

  describe('Retry while the host is unreachable', () => {
    function failingClient(failedPaths: Set<string>): MockClient {
      return {
        sendRequest: vi.fn(async (_method: string, params: { relativePath: string }) =>
          failedPaths.has(params.relativePath)
            ? {
                id: 'response-id',
                ok: false,
                error: { code: 'internal', message: 'read failed' },
                _meta: { runtimeId: 'runtime-id' }
              }
            : ok(params.relativePath === '' ? [entry('src', true)] : [entry('app.ts')])
        )
      }
    }

    async function unreachableAfterRootFailure(): Promise<ReactTestRenderer> {
      mockTransport.client = failingClient(new Set(['']))
      const renderer = await renderExplorer()
      mockTransport.connectionState = 'reconnecting'
      await updateExplorer(renderer)
      return renderer
    }

    function retryButtons(renderer: ReactTestRenderer) {
      return renderer.root
        .findAll((node) => String(node.type) === 'Pressable')
        .filter((node) =>
          node
            .findAll((node) => String(node.type) === 'Text')
            .some((text) => text.props.children === 'Retry')
        )
    }

    it('offers no root Retry on the page, where nothing can re-dial', async () => {
      mockTransport.forceReconnect = null
      const renderer = await unreachableAfterRootFailure()
      expect(renderedText(renderer)).toContain('Waiting for desktop...')
      expect(retryButtons(renderer)).toHaveLength(0)
    })

    it('still offers it natively, and re-dials this host', async () => {
      const forceReconnect = vi.fn()
      mockTransport.forceReconnect = forceReconnect
      const renderer = await unreachableAfterRootFailure()
      const [retry] = retryButtons(renderer)
      await act(async () => {
        retry?.props.onPress()
      })
      expect(forceReconnect.mock.calls).toEqual([['host-a']])
    })

    it("keeps a folder's Retry on the page, whose read runs when the shell reconnects", async () => {
      // The one retry that does something without a re-dial: it queues the folder, and the
      // queue drains on the next `connected` whoever brought it back.
      mockTransport.forceReconnect = null
      const client = failingClient(new Set(['src']))
      mockTransport.client = client
      const renderer = await renderExplorer()
      await pressByLabel(renderer, 'Open folder src')
      await vi.waitFor(() => expect(renderedText(renderer)).toContain('read failed'))
      mockTransport.connectionState = 'reconnecting'
      await updateExplorer(renderer)
      client.sendRequest = failingClient(new Set()).sendRequest
      await pressByLabel(renderer, 'Retry loading src')
      mockTransport.connectionState = 'connected'
      await updateExplorer(renderer)
      await vi.waitFor(() =>
        expect(client.sendRequest).toHaveBeenLastCalledWith('files.readDirPage', {
          worktree: 'id:worktree-a',
          relativePath: 'src'
        })
      )
    })
  })
})
