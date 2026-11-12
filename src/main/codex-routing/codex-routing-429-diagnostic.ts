import { CODEX_FAILURE_BODY_LIMIT, type CodexEngineFailure } from './codex-quota-failover'

type LocalOrigin = 'host-budget' | 'native-affinity' | 'replay-capacity'
type KnownCode =
  | 'usage_limit_reached'
  | 'turn_rate_limit_exceeded'
  | 'model_cooldown'
  | 'rate_limit_exceeded'
  | 'insufficient_quota'
  | 'unrecognized'
type KnownType = 'usage_limit_reached' | 'rate_limit_error' | 'unrecognized'

function knownCode(value: unknown): KnownCode {
  switch (value) {
    case 'usage_limit_reached':
    case 'turn_rate_limit_exceeded':
    case 'model_cooldown':
    case 'rate_limit_exceeded':
    case 'insufficient_quota':
      return value
    default:
      return 'unrecognized'
  }
}

function knownType(value: unknown): KnownType {
  return value === 'usage_limit_reached' || value === 'rate_limit_error' ? value : 'unrecognized'
}

export function recordLocalCodex429(origin: LocalOrigin): void {
  console.warn('[codex-routing] 429', {
    origin,
    status: 429,
    code: 'unrecognized',
    type: 'unrecognized',
    complete: true,
    terminal: false
  })
}

export function recordUpstreamCodex429(input: {
  body?: Uint8Array
  contentType: string
  complete: boolean
  terminal: boolean
  retryAfter?: string | string[]
  failure?: CodexEngineFailure | null
}): void {
  let code: KnownCode = 'unrecognized'
  let type: KnownType = 'unrecognized'
  if (
    input.complete &&
    input.body &&
    input.body.byteLength <= CODEX_FAILURE_BODY_LIMIT &&
    /^application\/json(?:\s*;|$)/i.test(input.contentType)
  ) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(input.body).toString('utf8'))
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const error = parsed.error
        if (error && typeof error === 'object') {
          code = knownCode('code' in error ? error.code : undefined)
          type = knownType('type' in error ? error.type : undefined)
        }
      }
    } catch {
      // Malformed rejection bodies carry no diagnostic fields.
    }
  }
  const retryAfter = input.retryAfter
  const retryAfterSeconds =
    typeof retryAfter === 'string' && /^(?:0|[1-9]\d{0,4})$/.test(retryAfter)
      ? Number(retryAfter)
      : undefined
  console.warn('[codex-routing] 429', {
    origin: 'upstream',
    status: 429,
    code,
    type,
    complete: input.complete,
    terminal: input.terminal,
    ...(retryAfterSeconds !== undefined && retryAfterSeconds <= 86_400
      ? { retryAfterSeconds }
      : {}),
    ...(input.failure?.kind === 'quota' && input.failure.resetsAt !== undefined
      ? { resetAt: input.failure.resetsAt }
      : {})
  })
}
