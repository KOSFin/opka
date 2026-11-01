import { z } from 'zod'
import { salvagingArray } from '../../../src/shared/zod-salvage'
import { prCount, prFlag, prNullableText, prText } from '../session/github-pr-entity-reply-schema'

export const gitLabReviewersSchema = salvagingArray(
  z.looseObject({ username: z.string().min(1), name: prNullableText('name') })
)
export const gitLabMrFilesSchema = salvagingArray(
  z.object({
    path: z.string().min(1),
    oldPath: prText('oldPath'),
    status: prText('status'),
    additions: prCount('additions'),
    deletions: prCount('deletions'),
    isBinary: prFlag('isBinary')
  })
)
