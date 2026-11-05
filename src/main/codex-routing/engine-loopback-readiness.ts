import { request } from 'node:http'

/** Node's direct HTTP socket does not inherit a global fetch proxy dispatcher. */
export function engineLoopbackReady(
  port: number,
  clientKey: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/models',
        method: 'GET',
        agent: false,
        headers: { authorization: `Bearer ${clientKey}` }
      },
      (response) => {
        clearTimeout(timer)
        resolve(response.statusCode === 200)
        response.destroy()
      }
    )
    const timer = setTimeout(() => {
      probe.destroy()
      resolve(false)
    }, timeoutMs)
    probe.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    probe.end()
  })
}
