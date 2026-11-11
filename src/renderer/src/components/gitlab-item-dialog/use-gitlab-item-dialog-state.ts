/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: GitLab item dialogs reset draft/provider state and hydrate details from GitLab IPC when the selected item identity changes. */
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { GitLabAssignableUser, GitLabWorkItemDetails } from '../../../../shared/gitlab-types'
import type { JobTraceState } from '../gitlab-item-dialog-parts'

type ScopedDetails = {
  scope: { key: string | null }
  details: GitLabWorkItemDetails | null
  loading: boolean
  error: string | null
}

export function useGitLabItemDialogState(itemScopeKey: string | null) {
  const scope = useMemo(() => ({ key: itemScopeKey }), [itemScopeKey])
  const [detailState, setDetailState] = useState<ScopedDetails>({
    scope,
    details: null,
    loading: false,
    error: null
  })
  const currentScopeRef = useRef(scope)
  useLayoutEffect(() => {
    currentScopeRef.current = scope
  }, [scope])
  const currentDetails = detailState.scope === scope
  const details = currentDetails ? detailState.details : null
  const loading = currentDetails ? detailState.loading : itemScopeKey !== null
  const error = currentDetails ? detailState.error : null
  const updateDetails = useCallback(
    (update: (current: ScopedDetails) => ScopedDetails) => {
      setDetailState((previous) => {
        if (currentScopeRef.current !== scope) {
          return previous
        }
        const current =
          previous.scope === scope
            ? previous
            : { scope, details: null, loading: false, error: null }
        return update(current)
      })
    },
    [scope]
  )
  const setDetails: Dispatch<SetStateAction<GitLabWorkItemDetails | null>> = useCallback(
    (value) =>
      updateDetails((current) => ({
        ...current,
        details: typeof value === 'function' ? value(current.details) : value
      })),
    [updateDetails]
  )
  const setLoading: Dispatch<SetStateAction<boolean>> = useCallback(
    (value) =>
      updateDetails((current) => ({
        ...current,
        loading: typeof value === 'function' ? value(current.loading) : value
      })),
    [updateDetails]
  )
  const setError: Dispatch<SetStateAction<string | null>> = useCallback(
    (value) =>
      updateDetails((current) => ({
        ...current,
        error: typeof value === 'function' ? value(current.error) : value
      })),
    [updateDetails]
  )
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [commentDraftState, setCommentDraftState] = useState<{
    scopeKey: string | null
    value: string
  }>(() => ({ scopeKey: itemScopeKey, value: '' }))
  const commentDraft = commentDraftState.scopeKey === itemScopeKey ? commentDraftState.value : ''
  if (commentDraftState.scopeKey !== itemScopeKey) {
    // Why: comment drafts are tied to one GitLab item, so switching the sheet
    // target must not leave a draft that could post to the wrong MR/issue.
    setCommentDraftState({ scopeKey: itemScopeKey, value: '' })
  }
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [resolvingThreadId, setResolvingThreadId] = useState<string | null>(null)
  const [editingDetailsState, setEditingDetails] = useState(false)
  const editingDetails = currentDetails ? editingDetailsState : false
  const [titleDraft, setTitleDraft] = useState('')
  const [bodyDraft, setBodyDraft] = useState('')
  const [labelDraft, setLabelDraft] = useState('')
  const [labelOptions, setLabelOptions] = useState<string[] | null>(null)
  const [labelOptionsLoading, setLabelOptionsLoading] = useState(false)
  const [detailsSaving, setDetailsSaving] = useState(false)
  const [reviewerOptions, setReviewerOptions] = useState<GitLabAssignableUser[] | null>(null)
  const [reviewerOptionsLoading, setReviewerOptionsLoading] = useState(false)
  const [reviewerUpdating, setReviewerUpdating] = useState(false)
  const [reviewerDraftId, setReviewerDraftId] = useState('')
  const [inlineCommentFilePath, setInlineCommentFilePath] = useState('')
  const [inlineCommentLine, setInlineCommentLine] = useState('')
  const [inlineCommentBody, setInlineCommentBody] = useState('')
  const [inlineCommentSubmitting, setInlineCommentSubmitting] = useState(false)
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null)
  const [jobTraceById, setJobTraceById] = useState<Record<number, JobTraceState>>({})
  const [retryingJobId, setRetryingJobId] = useState<number | null>(null)
  const [actionInFlight, setActionInFlight] = useState<'close' | 'reopen' | 'merge' | null>(null)
  const mountedRef = useMountedRef()
  const updateCommentDraft = useCallback(
    (value: string): void => {
      setCommentDraftState({ scopeKey: itemScopeKey, value })
    },
    [itemScopeKey]
  )

  return {
    actionInFlight,
    bodyDraft,
    commentDraft,
    commentSubmitting,
    details,
    detailsSaving,
    editingDetails,
    error,
    expandedJobId,
    inlineCommentBody,
    inlineCommentFilePath,
    inlineCommentLine,
    inlineCommentSubmitting,
    jobTraceById,
    labelDraft,
    labelOptions,
    labelOptionsLoading,
    loading,
    mountedRef,
    refreshNonce,
    resolvingThreadId,
    retryingJobId,
    reviewerDraftId,
    reviewerOptions,
    reviewerOptionsLoading,
    reviewerUpdating,
    setActionInFlight,
    setBodyDraft,
    setCommentDraftState,
    setCommentSubmitting,
    setDetails,
    setDetailsSaving,
    setEditingDetails,
    setError,
    setExpandedJobId,
    setInlineCommentBody,
    setInlineCommentFilePath,
    setInlineCommentLine,
    setInlineCommentSubmitting,
    setJobTraceById,
    setLabelDraft,
    setLabelOptions,
    setLabelOptionsLoading,
    setLoading,
    setRefreshNonce,
    setResolvingThreadId,
    setRetryingJobId,
    setReviewerDraftId,
    setReviewerOptions,
    setReviewerOptionsLoading,
    setReviewerUpdating,
    setTitleDraft,
    titleDraft,
    updateCommentDraft
  }
}

export type GitLabItemDialogState = ReturnType<typeof useGitLabItemDialogState>
