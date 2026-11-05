import { isAbsolute } from 'node:path'
import { nativeClaudeCanonicalMetadataSource } from '../../shared/native-claude-canonical-metadata'
import { nativeClaudeTaskNotificationParserSource } from '../../shared/claude-task-notification-text'
import { readClaudeBackgroundTaskLaunch } from '../../shared/claude-owed-task-notifications'

/** Public native middleware contains no provider credentials or model/user message payloads. */
export function createClaudeNativeCoverageModule(
  launchId: string,
  launch: { command: string; args: string[] }
): string {
  if (!isAbsolute(launch.command)) {
    throw new Error('Native continuity requires the owning CLI launcher.')
  }
  return `${nativeClaudeCanonicalMetadataSource()}
${nativeClaudeTaskNotificationParserSource().replace('export function', 'function')}
const readLaunch = ${readClaudeBackgroundTaskLaunch.toString()};
const argv = ${JSON.stringify([launch.command, ...launch.args, 'agent', 'native-pool-observe', launchId])};
const unavailable = 'Account host unavailable; reconnect or restart this native session.';
const generation = crypto.randomUUID();
let sequence = 0, pending = 0, broken = false, draftMarked = false, draftVersion = 0;
let serial = Promise.resolve();
async function ack($, observation) {
  if (pending >= 256) { broken = true; throw new Error(unavailable) }
  pending++;
  const number = ++sequence;
  const operation = serial.then(async () => {
    const sessionId = await $.session.id();
    const result = await $.process.run(argv, { stdin: JSON.stringify({sessionId, generation, sequence:number, observation}), timeoutMs:60000 });
    if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error(unavailable);
    const reply = JSON.parse(result.stdout);
    if (reply.sequence !== number || typeof reply.healthy !== 'boolean') throw new Error(unavailable);
    return reply;
  });
  serial = operation.then(() => {}, () => {});
  try { return await operation } catch { broken = true; throw new Error(unavailable) } finally { pending-- }
}
async function markDraft($, active) {
  if (active !== draftMarked) { draftMarked = active; await ack($,{kind:'draft',active}) }
}
async function confirmDraft($) {
  const version=draftVersion;
  try {
    const draft=await $.prompt.read();
    if(version!==draftVersion)return false;
    draftMarked=draft.text.length>0;
    await ack($,{kind:'draft',active:draftMarked});
    return true;
  } catch {await lost($,'draft-read');return false}
}
async function lost($, stage) {
  try { await ack($,{kind:'lost',stage}) } catch {}
}
const zero = {input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0};
const ended = status => status === 'completed' || status === 'failed' || status === 'killed';
async function canonical($,event,e,next) {
  const origin=next.origin;
  const source=origin?.plugin==='engine'&&origin?.tier==='core'?'engine':origin?'plugin':'unverifiable';
  const payload={...e,session_id:e.session_id??await $.session.id()};
  await ack($,{kind:'canonical-hook',hook:canonicalMetadata(event,payload,source)});
}
export function register(on) {
  ${[
    'SessionStart',
    'UserPromptSubmit',
    'StopFailure',
    'SubagentStart',
    'SubagentStop',
    'PermissionRequest',
    'PostToolUse',
    'PostToolUseFailure'
  ]
    .map(
      (event) =>
        `on('classic.${event}',async($,e,next)=>{${event === 'StopFailure' ? 'await confirmDraft($);' : ''}await canonical($,'${event}',e,next);return next(e)}).catch(async($,e,next)=>{await lost($,'stop');return next(e)});`
    )
    .join('\n')}
  on('prompt.edit', async ($,e,next) => {
    const version=++draftVersion;
    const nonempty = e.text.length - (e.end-e.start) + e.inputText.length > 0;
    try { if (nonempty) await markDraft($,true) }
    catch { await lost($,'draft') }
    const result = await next(e);
    try { if(version===draftVersion) await markDraft($,result.text.length>0) } catch { await lost($,'draft') }
    return result;
  }).catch(async ($,e,next) => { await lost($,'draft'); return next(e) });
  on('prompt.change', async ($,e,next) => { draftVersion++; try { await markDraft($,e.text.length>0) } catch { await lost($,'draft') };return next(e) });
  on('prompt.submit', async ($,e,next) => {
    if (broken) return {drop:unavailable};
    const id=crypto.randomUUID();
    const task=e.origin.kind==='task-notification'?readClaudeTaskNotification(e.text):null;
    const markers=e.text.match(/<opka-native-wake:v1:[a-f0-9-]{36}:[12]:[a-f0-9]{64}>/g);
    const reply=await ack($,{kind:'prompt',submissionId:id,origin:e.origin.kind,meta:e.isMeta===true,taskId:task?.taskId,taskStatus:task?.status,wakeMarker:markers?.length===1?markers[0]:undefined});
    if(reply.drop){await ack($,{kind:'prompt-end',id,dropped:true});return{drop:'An obsolete account continuation was cancelled.'}};
    await confirmDraft($);
    const result=await next(e);
    await ack($,{kind:'prompt-end',id,dropped:typeof result.drop==='string'});
    return result;
  }).catch(async ($,e,next)=>{await lost($,'prompt');return next.called?next(e):{drop:unavailable}});
  on('tool.call',async($,e,next)=>{
    if(broken)return{deny:unavailable};
    await ack($,{kind:'tool-start',id:e.tool_use_id,tool:e.tool,agentId:e.agentId});
    await canonical($,'PreToolUse',{agent_id:e.agentId,tool_use_id:e.tool_use_id,tool_name:e.tool},next);
    const result=await next(e);
    const task=readLaunch(e.tool,result.result);
    if(['CronCreate','ScheduleWakeup','Workflow'].includes(e.tool))await lost($,'tool');
    await ack($,{kind:'tool-end',id:e.tool_use_id,task:task??undefined,agentId:e.agentId});
    return result;
  }).catch(async($,e,next)=>{await lost($,'tool');return next.called?next(e):{deny:unavailable}});
  on('agent.spawn',async($,e,next)=>{
    if(broken)return{deny:unavailable};
    const id=crypto.randomUUID();await ack($,{kind:'spawn-start',id});
    const result=await next(e);
    if(!result.deny&&!result.agentId)await lost($,'spawn');
    await ack($,{kind:'spawn-end',id,agentId:result.agentId,parentAgentId:e.parentAgentId});return result;
  }).catch(async($,e,next)=>{await lost($,'spawn');return next.called?next(e):{deny:unavailable}});
  on('turn.start',async($,e,next)=>{await ack($,{kind:'turn-start',id:e.turnId,agentId:e.agentId});return next(e)}).catch(async($,e,next)=>{await lost($,'turn-start');return next(e)});
  on('turn.step',async function*($,e,next){
    const id='turn:'+crypto.randomUUID();let accepted=false;
    try {
      if(broken)throw new Error(unavailable);
      await ack($,{kind:'request-start',id,mainTurnId:e.agentId?undefined:e.turnId});accepted=true;
      return yield* next(e);
    } catch(error) {
      if(next.called)throw error;
      await lost($,'request');try{await ack($,{kind:'control-failed'})}catch{};$.ui.log(unavailable);
      yield{kind:'stop',stopReason:null,usage:null};
      return{turnId:e.turnId,index:e.index,answer:'',toolUses:[],stopReason:null,usage:null};
    } finally {if(accepted){try{await ack($,{kind:'request-end',id})}catch{await lost($,'request')}}}
  });
  on('model.complete',async($,e,next)=>{
    const id='aux:'+crypto.randomUUID();let accepted=false;
    try{
      if(broken)throw new Error(unavailable);
      await ack($,{kind:'request-start',id});accepted=true;return await next(e);
    }catch(error){if(next.called)throw error;await lost($,'aux');return{isAnswered:false,reason:'aborted',usage:zero}}
    finally{if(accepted){try{await ack($,{kind:'request-end',id})}catch{await lost($,'aux')}}}
  });
  on('turn.complete',async($,e,next)=>{
    const result=await next(e);const all=await $.agent.list();
    if(!Array.isArray(all)||all.some(agent=>typeof agent.id!=='string'||typeof agent.status!=='string')){await lost($,'turn-end');return result};
    const active=all.filter(agent=>!ended(agent.status));
    if(active.length>256){await lost($,'turn-end');return result};
    const terminal=all.filter(agent=>ended(agent.status)).slice(-(256-active.length));
    const agents=[...active,...terminal].slice(0,256).map(agent=>({id:agent.id,status:agent.status}));
    await ack($,{kind:'turn-end',id:e.turnId,agentId:e.agentId,reason:e.reason,agents});return result;
  }).catch(async($,e,next)=>{await lost($,'turn-end');return next(e)});
  on('classic.Stop',async($,e,next)=>{
    const result=await next(e);
    const draftConfirmed=await confirmDraft($);
    if(!result.block&&!result.preventContinuation)await canonical($,'Stop',e,next);
    if(draftConfirmed&&!broken&&!e.agent_id&&typeof e.prompt_id==='string'&&Array.isArray(e.background_tasks)&&!result.block&&!result.preventContinuation)await ack($,{kind:'complete-stop',promptId:e.prompt_id});
    return result;
  }).catch(async($,e,next)=>{await lost($,'stop');return next(e)});
}
`
}
