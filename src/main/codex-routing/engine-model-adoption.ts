import { request } from 'node:http'
import type { EngineRuntimeHandle } from './engine-runtime'

/** Reads the engine's local registry only; never sends an inference or credential-verification request. */
export function readEngineModelPrefixes(runtime: EngineRuntimeHandle, signal: AbortSignal) {
  return new Promise<Set<string>>((resolve, reject) => {
    signal.throwIfAborted()
    const chunks: Buffer[] = []
    let size = 0
    const probe = request(
      {
        hostname: '127.0.0.1',
        port: runtime.port,
        path: '/v1/models',
        agent: false,
        signal,
        headers: { authorization: `Bearer ${runtime.clientKey}` }
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy()
          reject(new Error('Engine catalog is unavailable.'))
          return
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 1024 * 1024) {
            response.destroy(new Error('Engine catalog exceeds its byte budget.'))
            return
          }
          chunks.push(chunk)
        })
        response.once('error', reject)
        response.once('end', () => {
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const prefixes = new Set<string>()
            if (
              !body ||
              typeof body !== 'object' ||
              !('data' in body) ||
              !Array.isArray(body.data)
            ) {
              throw new Error('Engine catalog is invalid.')
            }
            for (const model of body.data) {
              if (
                model &&
                typeof model === 'object' &&
                'id' in model &&
                typeof model.id === 'string'
              ) {
                const slash = model.id.indexOf('/')
                if (slash > 0) {
                  prefixes.add(model.id.slice(0, slash))
                }
              }
            }
            resolve(prefixes)
          } catch {
            reject(new Error('Engine catalog is invalid.'))
          }
        })
      }
    )
    probe.setTimeout(1000, () => probe.destroy(new Error('Engine catalog deadline.')))
    probe.once('error', reject)
    probe.end()
  })
}
