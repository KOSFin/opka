export type GitLabApprovalState = {
  approvalsRequired: number | null
  approvalsLeft: number | null
}

export function gitLabApprovalLabel(approval: GitLabApprovalState | undefined): string | null {
  if (!approval || approval.approvalsRequired === null) {
    return null
  }
  if (approval.approvalsRequired === 0) {
    return 'No approvals required'
  }
  if (approval.approvalsLeft === null) {
    return `${approval.approvalsRequired} approvals required`
  }
  return approval.approvalsLeft === 0
    ? 'Approved'
    : `${approval.approvalsLeft} of ${approval.approvalsRequired} approvals remaining`
}
