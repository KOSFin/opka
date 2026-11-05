import { runProcess } from '@orca/process-host'
import { randomUUID } from 'node:crypto'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'

export async function reserveDarwinRefreshHosts() {
  if (!isDarwinNativeProbeCi()) {
    throw new Error('Synthetic hosts changes require isolated Darwin CI')
  }
  const marker = `opka-fake-refresh-${randomUUID()}`
  const mutate = async (operation) => {
    const result = await runProcess({
      program: '/usr/bin/sudo',
      args: [
        '-n',
        '/usr/bin/python3',
        '-c',
        `
import os,sys
operation,marker=sys.argv[1:]
path='/etc/hosts'
line=('127.0.0.1 claude.fedstart.com # '+marker+'\\n').encode()
with open(path,'r+b') as file:
    import fcntl
    fcntl.flock(file,fcntl.LOCK_EX)
    data=file.read(1048577)
    if len(data)>1048576: raise RuntimeError('Hosts bound exceeded')
    if operation=='reserve':
        if b'claude.fedstart.com' in data: raise RuntimeError('Existing domain mapping')
        if not data.endswith(b'\\n'): raise RuntimeError('Unexpected hosts terminator')
        updated=data+line
    else:
        if data.count(line)!=1: raise RuntimeError('Owned line is unverifiable')
        updated=data.replace(line,b'',1)
    file.seek(0); file.write(updated); file.truncate(); file.flush(); os.fsync(file.fileno())
`,
        operation,
        marker
      ],
      timeoutMs: 5000,
      maxOutputBytes: 1024
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error('Synthetic CI hosts reservation failed')
    }
  }
  await mutate('reserve')
  return () => mutate('release')
}
