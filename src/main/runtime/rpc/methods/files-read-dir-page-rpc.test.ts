import '../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

it('keeps the complete directory read while serving a bounded page', async () => {
  const page = { entries: [{ name: 'src', isDirectory: true }], nextCursor: 'opaque' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this dispatcher reaches only the two mocked directory methods and runtime ID.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    readFileExplorerDir: vi.fn().mockResolvedValue([{ name: 'src', isDirectory: true }]),
    readFileExplorerDirPage: vi.fn().mockResolvedValue(page)
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

  const response = await dispatcher.dispatch({
    id: 'req-1',
    authToken: 'tok',
    method: 'files.readDir',
    params: { worktree: 'id:wt-1', relativePath: '' }
  })
  expect(runtime.readFileExplorerDir).toHaveBeenCalledWith('id:wt-1', '')
  expect(response).toMatchObject({ ok: true, result: [{ name: 'src', isDirectory: true }] })

  const pageResponse = await dispatcher.dispatch({
    id: 'req-2',
    authToken: 'tok',
    method: 'files.readDirPage',
    params: { worktree: 'id:wt-1', relativePath: '', limit: 1 }
  })
  expect(runtime.readFileExplorerDirPage).toHaveBeenCalledWith(
    'id:wt-1',
    '',
    expect.objectContaining({ limit: 1 })
  )
  expect(pageResponse).toMatchObject({ ok: true, result: page })
})
