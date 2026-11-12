export async function syntheticTurn(launch: { baseUrl: string; apiKey: string }, turn = '1') {
  const response = await fetch(`${launch.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${launch.apiKey}`,
      'content-type': 'application/json',
      'x-codex-turn-metadata': JSON.stringify({ thread_id: 'synthetic-thread', turn_id: turn })
    },
    body: JSON.stringify({ model: 'synthetic', input: 'local fixture' })
  })
  await response.arrayBuffer()
  return response
}
