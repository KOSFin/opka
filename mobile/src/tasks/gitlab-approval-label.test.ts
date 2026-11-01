import { describe, expect, it } from 'vitest'
import { gitLabApprovalLabel } from './gitlab-approval-label'

describe('GitLab approval presentation', () => {
  it('does not label missing approval evidence as approved', () => {
    expect(gitLabApprovalLabel(undefined)).toBeNull()
    expect(gitLabApprovalLabel({ approvalsRequired: null, approvalsLeft: 0 })).toBeNull()
  })

  it('distinguishes no approval requirement from an accepted required review', () => {
    expect(gitLabApprovalLabel({ approvalsRequired: 0, approvalsLeft: 0 })).toBe(
      'No approvals required'
    )
    expect(gitLabApprovalLabel({ approvalsRequired: 2, approvalsLeft: 0 })).toBe('Approved')
  })

  it('retains the outstanding review count and unknown remaining state', () => {
    expect(gitLabApprovalLabel({ approvalsRequired: 2, approvalsLeft: 1 })).toBe(
      '1 of 2 approvals remaining'
    )
    expect(gitLabApprovalLabel({ approvalsRequired: 2, approvalsLeft: null })).toBe(
      '2 approvals required'
    )
  })
})
