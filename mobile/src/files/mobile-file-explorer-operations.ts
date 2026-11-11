import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { fileDirectoryPageSchema, legacyFileListSchema } from './file-explorer-reply-schema'

export const fileDirectoryPageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.read-directory-page-or-skip',
    method: 'files.readDirPage',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('directory-page', fileDirectoryPageSchema)
  })
)

/**
 * The legacy capped list. A second reader on `files.list`: the native-chat inventory's
 * `files.list-or-skip` reads the `files` member alone, and the explorer also needs `truncated` to
 * keep the "Showing first 5000" note. Widening that one to a payload reader would split the
 * `workspace-files` variant it shares with `files.searchPaths`, whose caller feeds both through one
 * `extractPaths`, and only move the member read into that hook — so the explorer declares its own.
 */
export const legacyFileListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.legacy-explorer-list-or-skip',
    method: 'files.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('legacy-file-list', legacyFileListSchema)
  })
)
