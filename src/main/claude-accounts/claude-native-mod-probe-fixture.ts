import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

/** Synthetic read-only public mod; model/tool contents never leave the native process. */
export async function installClaudeNativeModProbe(root: string, baseUrl: string) {
  const plugin = join(root, 'read-only-mod')
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true })
  await mkdir(join(plugin, 'hooks'))
  await writeFile(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'opka-native-coverage-fixture', version: '0.0.1' })
  )
  await writeFile(
    join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({ modules: ['./register.js'] })
  )
  await build({
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    outfile: join(plugin, 'hooks', 'register.js'),
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import {readClaudeBackgroundTaskLaunch} from ${JSON.stringify(resolve('src/shared/claude-owed-task-notifications.ts'))};
import {readClaudeTaskNotification} from ${JSON.stringify(resolve('src/shared/claude-task-notification-text.ts'))};
async function emit($,event,fields={}) {const response=await $.http.fetch(${JSON.stringify(`${baseUrl}/mod-event`)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event,...fields})});if(!response.ok)throw new Error('Synthetic mod observer refused')}
export function register(on) {
 on('session.start',async($,e,next)=>{await emit($,'mod-loaded');return next(e)})
 on('tool.call',async($,e,next)=>{await emit($,'mod-tool-start',{tool:e.tool,child:!!e.agentId});if(e.tool==='mcp__opka_fixture__fail_guard')throw new Error('Synthetic mod failure');const result=await next(e);if(e.tool==='mcp__opka_fixture__echo')throw new Error('Synthetic post-next failure');const launch=readClaudeBackgroundTaskLaunch(e.tool,result.result);await emit($,'mod-tool-done',{tool:e.tool,child:!!e.agentId,denied:!!result.deny,isError:!!result.isError,taskId:launch?.id,taskKind:launch?.kind});return result}).catch(async($,e,next)=>{if(next.called){await emit($,'mod-tool-catch-after-next',{tool:e.tool});return next(e)}await emit($,'mod-tool-failed-closed',{tool:e.tool});return{deny:'Synthetic mod failure refused this call.'}})
 on('turn.step',async function*($,e,next){await emit($,'mod-request-start',{child:!!e.agentId});try{return yield* next(e)}finally{await emit($,'mod-request-end',{child:!!e.agentId})}})
 on('turn.complete',async($,e,next)=>{await emit($,'mod-turn-complete-enter',{child:!!e.agentId});const completed=await next(e);let agents=[];try{const rows=await $.agent.list();agents=Array.isArray(rows)?rows.map(row=>({id:row.id,status:row.status??row.state??'unknown',keys:Object.keys(row).slice(0,16)})):[{status:'unknown-shape'}]}catch{agents=[{status:'unverifiable'}]};await emit($,'mod-turn-complete',{child:!!e.agentId,reason:e.reason,aborted:e.isAborted===true,agents});return completed})
 on('prompt.submit',async($,e,next)=>{const task=e.origin?.kind==='task-notification'?readClaudeTaskNotification(e.text):null;await emit($,'mod-prompt-submit',{origin:e.origin?.kind??'none',taskId:task?.taskId,taskStatus:task?.status});return next(e)})
 on('session.append',async($,e,next)=>{const text=e.origin?.kind==='task-notification'?e.message.content.filter(block=>block.type==='text').map(block=>block.text??'').join('\\n'):'';const task=readClaudeTaskNotification(text);await emit($,'mod-session-append',{origin:e.origin?.kind??'none',door:e.door,taskId:task?.taskId,taskStatus:task?.status});return next(e)})
 on('session.receive',async($,e,next)=>{const task=e.origin?.kind==='task-notification'?readClaudeTaskNotification(typeof e.text==='string'?e.text:''):null;await emit($,'mod-session-receive',{origin:e.origin?.kind??'none',taskId:task?.taskId,taskStatus:task?.status});return next(e)})
}
`
    }
  })
  const mcp = join(root, 'synthetic-mcp.mjs'),
    mcpConfig = join(root, 'mcp.json'),
    mcpReceipt = join(root, 'mcp-executed.json')
  await writeFile(
    mcp,
    `import readline from 'node:readline';import{writeFileSync,readFileSync}from'node:fs';
for await(const line of readline.createInterface({input:process.stdin})){if(line.length>2097152)break;const request=JSON.parse(line);if(!('id'in request))continue;let result={};if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'opka_fixture',version:'0.0.1'}};if(request.method==='tools/list')result={tools:['echo','fail_guard'].map(name=>({name,description:'Fixed synthetic fixture tool',inputSchema:{type:'object',properties:{value:{type:'string'}}}}))};if(request.method==='tools/call'){let calls=0;try{calls=JSON.parse(readFileSync(${JSON.stringify(mcpReceipt)},'utf8')).calls??0}catch{};writeFileSync(${JSON.stringify(mcpReceipt)},JSON.stringify({tool:request.params.name,calls:calls+1}));result={content:[{type:'text',text:'synthetic-mcp-result'}]}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n')}`,
    { mode: 0o600 }
  )
  await writeFile(
    mcpConfig,
    JSON.stringify({ mcpServers: { opka_fixture: { command: process.execPath, args: [mcp] } } }),
    { mode: 0o600 }
  )
  return { plugin, mcpConfig, mcpReceipt }
}

/** Persist public generated declarations and sanitized tool evidence before temporary HOME removal. */
export async function persistClaudeNativeModProbe(
  mod: Awaited<ReturnType<typeof installClaudeNativeModProbe>>,
  receiptPath: string | undefined
) {
  const declarations: { name: string; bytes: number; sha256: string }[] = []
  for (const name of ['claude-code', 'claude-code-tools']) {
    const source = await readFile(
      join(mod.plugin, '.claude-plugin', 'types', name, 'index.d.ts')
    ).catch(() => null)
    if (!source || source.length > 2 * 1024 * 1024) {
      continue
    }
    declarations.push({
      name,
      bytes: source.length,
      sha256: createHash('sha256').update(source).digest('hex')
    })
    if (receiptPath) {
      await writeFile(`${receiptPath}.${name}.ts`, source, { mode: 0o600 })
    }
  }
  let mcp: { calls: number; tool: string } | undefined
  try {
    const raw: unknown = JSON.parse(await readFile(mod.mcpReceipt, 'utf8'))
    if (
      raw &&
      typeof raw === 'object' &&
      'calls' in raw &&
      typeof raw.calls === 'number' &&
      'tool' in raw &&
      (raw.tool === 'echo' || raw.tool === 'fail_guard')
    ) {
      mcp = { calls: raw.calls, tool: raw.tool }
    }
  } catch {
    /* The native run may end before an MCP call. */
  }
  return { declarations, mcp }
}
