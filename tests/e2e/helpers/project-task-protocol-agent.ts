import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildFakeAgentCommandOverride } from './fake-agent-command-override'
import { FAKE_AGENT_PASTE_END_SCANNER_SOURCE } from './fake-agent-paste-end-scanner'
import { FAKE_CODEX_LAUNCH_PROBES_SOURCE } from './fake-codex-launch-probes'

export function installProjectTaskProtocolAgent(directory: string): string {
  const source = `
${FAKE_CODEX_LAUNCH_PROBES_SOURCE}
process.stdout.write('\\u001b]0;Codex Ready\\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
process.stdin.on('data',(chunk)=>{
  const input=chunk.toString()
  const scan=scanFakeAgentPasteEnd(fakeAgentPasteEndTail,input)
  fakeAgentPasteEndTail=scan.tail
  if(scan.pasteEndOffset!==null){process.stdout.write('\\x1b[?25h')}
  fakeAgentMaybeAck(scan,input,()=>{process.stdout.write('\\u001b]0;Codex Working\\u0007ACK\\n');setTimeout(()=>process.stdout.write('\\u001b]0;Codex Ready\\u0007'),10)})
})
process.stdin.setRawMode?.(true)
for(const signal of ['SIGINT','SIGHUP','SIGTERM']){process.on(signal,()=>process.exit(0))}
process.stdin.resume()
setInterval(()=>{},60000)
`
  const executable = path.join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  if (process.platform === 'win32') {
    writeFileSync(path.join(directory, 'fake-codex.js'), source)
    writeFileSync(executable, '@echo off\r\nnode "%~dp0\\fake-codex.js" %*\r\n')
  } else {
    writeFileSync(executable, `#!/usr/bin/env node\n${source}`)
    chmodSync(executable, 0o755)
  }
  return buildFakeAgentCommandOverride(executable)
}
