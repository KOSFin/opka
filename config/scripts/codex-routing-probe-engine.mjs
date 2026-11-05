import { createServer } from 'node:net'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import { startSyntheticAccountForwarder } from './codex-routing-probe-forwarder.mjs'

export async function startSyntheticRoutingEngine({ program, root, upstream, env, explicit }) {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((done) => reservation.close(done))
  const home = join(root, 'routing-engine')
  await mkdir(home, { mode: 0o700 })
  const configPath = join(home, 'config.yaml')
  const managementKey = 'synthetic-probe-management-only'
  const clientKey = 'synthetic-no-real-account'
  const config = {
    'config-version': 8,
    server: { host: '127.0.0.1', port, 'max-request-body-bytes': 2 * 1024 * 1024 },
    management: {
      'allow-remote': false,
      'secret-key': managementKey,
      'disable-control-panel': true,
      'disable-auto-update-panel': true
    },
    access: { 'api-keys': [clientKey] },
    oauth: { 'auth-dir': join(home, 'empty-auth') },
    routing: {
      strategy: 'fill-first',
      'session-affinity': false,
      'force-model-prefix': Boolean(explicit),
      retry: { 'request-retry': 0 }
    },
    'api-keys': {
      codex: ['A', 'B'].map((id, index) => ({
        name: `synthetic-${id}`,
        ...(explicit ? { prefix: `opka-${id}` } : {}),
        priority: 1 - index,
        'base-url': upstream,
        'request-retry': 0,
        models: ['probe-a', 'probe-b'].map((name) => ({ name })),
        keys: [{ 'api-key': `synthetic-${id}`, 'disable-codex-cloaking': true }]
      }))
    },
    observability: {
      logs: { 'logging-to-file': false, 'request-log': false, 'error-logs-max-files': 1 },
      usage: { 'usage-statistics-enabled': false },
      pprof: { enable: false }
    }
  }
  const save = async () => {
    await writeFile(`${configPath}.next`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    await rename(`${configPath}.next`, configPath)
  }
  await save()
  const child = spawnProcess({
    program,
    args: ['-config', configPath, '-local-model'],
    env: { ...env, HOME: home, USERPROFILE: home },
    cwd: home,
    stdio: 'pipe'
  })
  let failure
  let forwarder
  let outputBytes = 0
  child.on('error', (error) => {
    failure = error
  })
  child.stdin.on('error', (error) => {
    failure = error
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      outputBytes += chunk.length
    })
  }
  const stop = async () => {
    await forwarder?.stop()
    child.stdin.end()
    if (child.pid && child.exitCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 2000)
      await closed
      clearTimeout(force)
    }
  }
  const base = `http://127.0.0.1:${port}`
  const waitConfig = async (selected) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (failure || !child.pid || child.exitCode !== null) {
        throw new Error('Isolated routing engine failed to start')
      }
      try {
        const response = await fetch(`${base}/v8/management/config`, {
          headers: { authorization: `Bearer ${managementKey}` },
          signal: AbortSignal.timeout(500)
        })
        if (response.ok) {
          const loaded = await response.json()
          const groups = loaded['api-keys']?.codex
          if (groups?.find((group) => group.name === `synthetic-${selected}`)?.priority === 1) {
            return
          }
        }
      } catch {
        /* A listener or config reload may still be starting. */
      }
      await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error('Synthetic engine configuration was not acknowledged')
  }
  try {
    await waitConfig('A')
    if (explicit) {
      forwarder = await startSyntheticAccountForwarder(base)
    }
    return {
      baseUrl: forwarder?.baseUrl ?? `${base}/v1`,
      outputBytes: () => outputBytes,
      async switchToB() {
        if (forwarder) {
          forwarder.switchToB()
          return
        }
        config['api-keys'].codex[0].priority = 0
        config['api-keys'].codex[1].priority = 1
        await save()
        await waitConfig('B')
      },
      stop
    }
  } catch (error) {
    await stop()
    throw error
  }
}
