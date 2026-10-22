import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { pluginPathSegmentError } from '../../shared/plugins/plugin-path-safety'
import {
  PROJECT_TASK_DOCUMENT_MAX_BYTES,
  type ProjectTaskDocument,
  type TaskProject
} from '../../shared/project-task-contract'

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const taskId = z.string().regex(new RegExp(`^task-${uuid}$`))
const alias = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
const relativePath = z
  .string()
  .max(512)
  .refine(
    (value) =>
      value.length > 0 &&
      !/^[/.]|[:\\]/.test(value) &&
      !value
        .split('/')
        .some(
          (part) =>
            pluginPathSegmentError(part) !== null ||
            ['.git', 'node_modules', '.orca'].includes(part)
        )
  )
const distinct = (values: string[]): boolean => new Set(values).size === values.length
const taskSchema = z
  .object({
    schema: z.literal(1),
    id: taskId,
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => ![...value].some((character) => character.charCodeAt(0) < 32)),
    kind: z.enum([
      'implementation',
      'investigation',
      'review',
      'integration',
      'documentation',
      'operations'
    ]),
    parent: taskId.nullable().default(null),
    depends_on: z.array(taskId).max(100).refine(distinct).default([]),
    repos: z.array(alias).max(100).refine(distinct).default([])
  })
  .strict()
  .refine(
    (value) => value.parent !== value.id && !value.depends_on.includes(value.id),
    'Task cannot reference itself'
  )

const projectSchema = z
  .object({
    schema: z.literal(1),
    id: z.string().regex(new RegExp(`^project-${uuid}$`)),
    repos: z
      .record(alias, z.union([z.literal('.'), relativePath]))
      .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 100),
    sources: z
      .array(z.object({ id: alias, path: relativePath }).strict())
      .min(1)
      .max(16)
  })
  .strict()
  .refine(
    (value) =>
      distinct(value.sources.map((source) => source.id)) &&
      distinct(value.sources.map((source) => source.path)) &&
      !value.sources.some((source, index) =>
        value.sources.some(
          (other, otherIndex) => index !== otherIndex && source.path.startsWith(`${other.path}/`)
        )
      ),
    'Task sources must be unique and non-overlapping'
  )

function yamlValue(content: string): unknown {
  if (Buffer.byteLength(content, 'utf8') > PROJECT_TASK_DOCUMENT_MAX_BYTES) {
    throw new Error('Task document exceeds 256 KiB')
  }
  const document = parseDocument(content, { uniqueKeys: true, strict: true })
  if (document.errors.length || document.warnings.length) {
    throw new Error('Invalid YAML metadata')
  }
  return document.toJS({ maxAliasCount: 0 })
}

export function taskRevision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function parseTaskProject(content: string): TaskProject {
  return projectSchema.parse(yamlValue(content))
}

export function parseProjectTask(content: string): ProjectTaskDocument {
  if (Buffer.byteLength(content, 'utf8') > PROJECT_TASK_DOCUMENT_MAX_BYTES) {
    throw new Error('Task document exceeds 256 KiB')
  }
  const frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!frontmatter) {
    throw new Error('Expected schema 1 YAML frontmatter in task.md')
  }
  const metadata = taskSchema.parse(yamlValue(frontmatter[1]))
  const body = content.slice(frontmatter[0].length)
  if (!body.trim()) {
    throw new Error('Task body is required')
  }
  return { ...metadata, content, body, revision: taskRevision(content) }
}
