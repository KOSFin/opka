import {
  SYNTHETIC_REASONING_CIPHERTEXT,
  SYNTHETIC_COMPACTION_CIPHERTEXT
} from './codex-native-probe-ciphertext.mjs'
import { readdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function collectNativeProbeRollouts(home) {
  const rollouts = []
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const item = join(path, entry.name)
      if (entry.isDirectory()) {
        await walk(item)
      } else if (entry.name.endsWith('.jsonl')) {
        if (rollouts.length >= 64) {
          throw new Error('Synthetic rollout count exceeded probe budget')
        }
        const bytes = (await stat(item)).size
        const images = []
        let encryptedReasoning = false
        const turnAborts = []
        const recordedProviders = []
        if (item.includes(`${join(home, 'sessions')}`) && bytes <= 2 * 1024 * 1024) {
          for (const line of (await readFile(item, 'utf8')).split('\n').filter(Boolean)) {
            const record = JSON.parse(line)
            if (
              record.type === 'session_meta' &&
              typeof record.payload?.model_provider === 'string' &&
              recordedProviders.length < 4
            ) {
              recordedProviders.push(record.payload.model_provider)
            }
            if (
              record.type === 'event_msg' &&
              record.payload?.type === 'turn_aborted' &&
              turnAborts.length < 128
            ) {
              turnAborts.push({ turnId: record.payload.turn_id, reason: record.payload.reason })
            }
            if (
              record.type === 'response_item' &&
              record.payload?.type === 'reasoning' &&
              record.payload.encrypted_content === SYNTHETIC_REASONING_CIPHERTEXT
            ) {
              encryptedReasoning = true
            }
            if (record.type === 'response_item' && Array.isArray(record.payload?.content)) {
              for (const content of record.payload.content) {
                if (content.type === 'input_image') {
                  images.push({
                    type: content.type,
                    imageUrlBytes:
                      typeof content.image_url === 'string'
                        ? Buffer.byteLength(content.image_url)
                        : null
                  })
                }
              }
            }
          }
        }
        rollouts.push({
          path: item.slice(home.length),
          bytes,
          ...(images.length ? { images } : {}),
          ...(recordedProviders.length ? { recordedProviders } : {}),
          ...(encryptedReasoning ? { encryptedReasoning } : {}),
          ...(turnAborts.length ? { turnAborts } : {})
        })
      }
    }
  }
  await walk(home)
  return rollouts
}

export function summarizeNativeProbeRequests(requests) {
  return requests.map((entry) => ({
    account: entry.account,
    model: entry.model,
    path: entry.path,
    requestKeys: entry.requestKeys,
    toolNames: entry.toolNames,
    syntheticEncryptedReasoning: entry.input?.some(
      (item) =>
        item.type === 'reasoning' && item.encrypted_content === SYNTHETIC_REASONING_CIPHERTEXT
    ),
    toolOutputs: entry.input
      ?.filter(
        (item) => item.type === 'function_call_output' || item.type === 'custom_tool_call_output'
      )
      .map((item) => ({
        type: item.type,
        callId: item.call_id,
        output: JSON.stringify(item.output).slice(0, 2000)
      })),
    metadata: entry.metadata,
    contentShapes: entry.input
      ?.filter((item) => Array.isArray(item.content))
      .flatMap((item) =>
        item.content.map((content) => ({
          type: content.type,
          keys: Object.keys(content),
          imageUrlBytes:
            typeof content.image_url === 'string' ? Buffer.byteLength(content.image_url) : null
        }))
      ),
    retainedA:
      Array.isArray(entry.input) &&
      entry.input.some(
        (item) =>
          item.role === 'assistant' && JSON.stringify(item.content).includes('SYNTHETIC_A_MARKER')
      )
  }))
}

/** Synthetic-only observation leaves production admission, body and response handling intact. */
export function captureNativeProbeRequests(server, report) {
  report.nativeWireEvidence = []
  server.on('request', (request) => {
    if (report.nativeWireEvidence.length >= 32) {
      return
    }
    const chunks = []
    let size = 0
    request.on('data', (bytes) => {
      size += bytes.length
      if (size <= 1024 * 1024) {
        chunks.push(bytes)
      }
    })
    // Observation must not drain a body while the production reader awaits its file.
    request.pause()
    request.on('end', () => {
      const evidence = {
        path: request.url?.replace(
          /\/native\/[A-Za-z0-9._-]{32,512}\/v1/g,
          '/native/<native-launch>/v1'
        ),
        bytes: size
      }
      if (size > 0 && size <= 1024 * 1024) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString())
          evidence.model = body.model
          evidence.syntheticEncryptedReasoning = body.input?.some(
            (item) =>
              item.type === 'reasoning' && item.encrypted_content === SYNTHETIC_REASONING_CIPHERTEXT
          )
        } catch {
          evidence.invalidJson = true
        }
      }
      report.nativeWireEvidence.push(evidence)
    })
  })
}

export function verifyNativeProbeRequests({
  requests,
  report,
  raw,
  candidates,
  execQuota,
  toolQuota,
  newConversation,
  vision,
  encryptedModel,
  compactMode,
  approval,
  approvalCapture,
  cancelMode,
  resumeMode
}) {
  const check = (value, message) => {
    if (!value) {
      throw new Error(message)
    }
  }
  if (approvalCapture) {
    check(
      report.authenticApprovalBlocked === true &&
        report.quotaReplaceAllowedDuringApproval === false,
      'Native approval did not block replacement'
    )
    report.nativeApprovalCapture = true
    return
  }
  const mainRequests = requests.filter(
    (entry) =>
      !entry.path.endsWith('/compact') &&
      JSON.parse(entry.metadata).thread_source !== 'thread_title' &&
      JSON.parse(entry.metadata).request_kind !== 'compaction'
  )
  check(
    mainRequests.length ===
      (toolQuota || vision || approval || cancelMode || report.resume?.builtinOpenaiPrototype
        ? 3
        : 2) &&
      mainRequests[0].account === 'synthetic-A' &&
      mainRequests.at(-1).account === 'synthetic-B',
    'Native account rotation did not match A→B'
  )
  if (!execQuota && !newConversation && !compactMode) {
    check(
      mainRequests
        .at(-1)
        .input.some(
          (item) =>
            item.role === 'assistant' && JSON.stringify(item.content).includes('SYNTHETIC_A_MARKER')
        ),
      'Native dialog history was lost'
    )
  }
  if (newConversation) {
    check(
      JSON.parse(mainRequests[0].metadata).thread_id !==
        JSON.parse(mainRequests[1].metadata).thread_id,
      'Native /new did not produce a new ROOT'
    )
  }
  if (resumeMode) {
    check(
      JSON.parse(mainRequests[0].metadata).thread_id ===
        JSON.parse(mainRequests[1].metadata).thread_id,
      'Native resume forked the owned conversation'
    )
    check(
      mainRequests[1].input.some(
        (item) =>
          item.type === 'reasoning' && item.encrypted_content === SYNTHETIC_REASONING_CIPHERTEXT
      ),
      'Native resumed encrypted reasoning was lost'
    )
    check(
      report.rollouts.some((item) => item.recordedProviders?.includes(report.resume.firstProvider)),
      'Native original provider namespace was not durably recorded'
    )
    if (report.resume?.builtinOpenaiPrototype) {
      check(
        report.nativeAuth.refreshRequests === 0 && report.localGateway.retiredRejected,
        'Authless gateway isolation failed'
      )
    }
    report.nativeResumeHistoryPreserved = true
  }
  if (cancelMode) {
    check(
      report.authenticNativeInterrupt && report.nativeUpstreamCancelled,
      'Native cancellation did not reach owned hook/upstream'
    )
    check(
      mainRequests[1].account === 'synthetic-A',
      'Cancelled turn changed account before fresh completion'
    )
    report.nativeCancellationPreserved = true
  }
  if (approval) {
    check(
      report.authenticApprovalBlocked &&
        report.policyChangedWhileBlocked &&
        report.quotaReplaceAllowedDuringApproval === false,
      'Native approval boundary proof was missing'
    )
    check(
      mainRequests[1].account === 'synthetic-A' &&
        JSON.stringify(mainRequests.at(-1).input).includes('SYNTHETIC_TOOL_EXECUTED'),
      'Approved tool result/account affinity was lost'
    )
    report.nativeApprovalFlow = true
  }
  if (compactMode) {
    const input = JSON.stringify(mainRequests.at(-1).input)
    report.nativeCompactionForwarded =
      input.includes(SYNTHETIC_COMPACTION_CIPHERTEXT) ||
      input.includes('SYNTHETIC_COMPACTED_CONTEXT')
    check(
      report.compactionImplementation && report.nativeCompactionForwarded,
      'Native compaction context missing in later selected account'
    )
  }
  if (encryptedModel) {
    check(
      mainRequests[1].model === 'gpt-6.1-terra',
      'Native model command did not change the later request model'
    )
    check(
      mainRequests
        .at(-1)
        .input.some(
          (item) =>
            item.type === 'reasoning' && item.encrypted_content === SYNTHETIC_REASONING_CIPHERTEXT
        ),
      'Native encrypted reasoning did not survive A→B'
    )
    report.encryptedReasoningForwarded = true
    report.nativeModelChangeForwarded = true
  }
  if (execQuota) {
    check(report.quotaStamp?.accepted === true, 'Quota authority did not accept verified rejection')
    check(
      JSON.stringify(requests.at(-2).input) === JSON.stringify(requests.at(-1).input),
      'Rejected request history changed on retry'
    )
    check(
      requests.at(-2).metadata === requests.at(-1).metadata,
      'Rejected request ROOT/turn metadata changed on retry'
    )
    check(!raw.includes('usage_limit_reached'), 'Rejected quota was exposed to native output')
    if (toolQuota) {
      check(
        requests
          .at(-1)
          .input.some(
            (item) =>
              item.type === 'function_call_output' &&
              JSON.stringify(item.output).includes('SYNTHETIC_TOOL_EXECUTED')
          ),
        'Native tool output missing after quota switch'
      )
    }
    report.nativeToolRoundtrip = toolQuota
    report.exactNativeInputRetained = true
    report.exactTurnMetadataRetained = true
    report.quotaRejectedOutputHidden = true
    report.authoritativeQuota = candidates().map(({ accountId, quota }) => ({ accountId, quota }))
  }
  if (vision) {
    report.nativeImageForwarded = requests.some((entry) =>
      JSON.stringify(entry.input).includes('input_image')
    )
    check(report.nativeImageForwarded, 'Native image missing from upstream request')
  }
}

export function printNativeProbeResult(report) {
  console.log(
    JSON.stringify({
      ok: report.ok,
      error: report.error,
      requests: report.requests?.length,
      hookEquality: report.hookSessionEqualsHttpRoot,
      nativeAuth: report.nativeAuth
    })
  )
}
