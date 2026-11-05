import type { RuntimeClient } from '../runtime-client'
import { readMetadata } from './metadata'
import { sendRequest } from './transport'
import { createRuntimeSourceFence } from './runtime-source-fence'
import { RuntimeClientError, RuntimeRpcFailureError } from './types'

/** Local CLI streams use the same endpoint authentication and source fence as unary requests. */
export async function streamRuntimeRequest(
  client: Pick<RuntimeClient, 'userDataPath' | 'isRemote'>,
  method: string,
  params: unknown,
  onFrame: (result: unknown) => void | Promise<void>,
  signal: AbortSignal,
  options?: { pauseTimeoutWhileConsuming?: boolean }
): Promise<void> {
  if (client.isRemote) {
    throw new RuntimeClientError(
      'invalid_environment',
      'Native terminal attachment must run on its execution host'
    )
  }
  const metadata = readMetadata(client.userDataPath)
  const fence = createRuntimeSourceFence(process.env, client.userDataPath, 60_000)
  const expected = await fence.check(metadata, method)
  const response = await sendRequest(metadata, method, params, 60_000, undefined, expected, {
    onFrame,
    signal,
    pauseTimeoutWhileConsuming: options?.pauseTimeoutWhileConsuming
  })
  if (!response.ok) {
    throw new RuntimeRpcFailureError(response)
  }
}
