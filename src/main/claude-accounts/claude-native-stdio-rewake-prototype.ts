import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Fixture-only public middleware experiment; production source is never changed. */
export function installSynchronousNativeRewakePrototype(
  directory: string,
  launchId: string,
  launch: { command: string; args: string[] },
  base: string
) {
  const path = join(directory, 'hooks', 'register.js')
  let source = readFileSync(path, 'utf8')
  const failure = "await canonical($,'StopFailure',e,next);return next(e)"
  const prompt = "await canonical($,'UserPromptSubmit',e,next);return next(e)"
  const registration = 'export function register(on) {'
  if (!source.includes(failure) || !source.includes(prompt) || !source.includes(registration)) {
    throw new Error('Native prototype source contract changed.')
  }
  source = source.replace(
    failure,
    "$.ui.log('opka-prototype-failure-entry');void prototypeReport($,{action:'failure-entry',lead:!e.agent_id,errorRate:e.error==='rate_limit'});await canonical($,'StopFailure',e,next);$.ui.log('opka-prototype-failure-acked');if(!e.agent_id)await prototypeWake($,'failure',e);return next(e)"
  )
  source = source.replace(
    prompt,
    "await canonical($,'UserPromptSubmit',e,next);const result=await next(e);if(!e.agent_id)await prototypeWake($,'fresh-wake',e);return result"
  )
  const helper = `
const prototypeArgv=${JSON.stringify([launch.command, ...launch.args, 'agent', 'native-pool-hook', launchId])};
let prototypeWakes=0;
const prototypeSeen=new Set();
async function prototypeReport($,value){await $.http.fetch(${JSON.stringify(`${base}/prototype-wake`)},{method:'POST',body:JSON.stringify(value)})}
async function prototypeWake($,action,e){
  await prototypeReport($,{action:action+'-attempt',errorRate:e.error==='rate_limit'});
  if(prototypeWakes>=2)return;
  const markerPattern=/<opka-native-wake:v1:[a-f0-9-]{36}:([12]):[a-f0-9]{64}>/g;
  const incoming=typeof e.prompt==='string'?[...e.prompt.matchAll(markerPattern)]:[];
  if(action==='fresh-wake'&&(incoming.length!==1||incoming[0][1]!=='1'))return;
  if(action==='failure'&&e.error!=='rate_limit')return;
  const sessionId=e.session_id??await $.session.id();
  const input={session_id:sessionId,prompt_id:e.prompt_id,
    ...(action==='failure'?{error:'rate_limit'}:{prompt:incoming[0][0]})};
  await prototypeReport($,{action:'helper-input',hasPrompt:typeof input.prompt_id==='string',hasSession:typeof input.session_id==='string'});
  let result;
  try{result=await $.process.run([...prototypeArgv,action],{stdin:JSON.stringify(input),timeoutMs:15000})}
  catch{await prototypeReport($,{action:'helper-rejected'});throw new Error('Prototype helper unavailable')}
  const markers=result.stderr.length<=1024?[...result.stderr.matchAll(markerPattern)]:[];
  await prototypeReport($,{action,code:result.exitCode,markers:markers.length,step:markers[0]?.[1]});
  if(result.exitCode!==2||result.isStderrTruncated||markers.length!==1||prototypeSeen.has(markers[0][0]))return;
  prototypeSeen.add(markers[0][0]);prototypeWakes++;
  const submitted=await $.prompt.submit({text:'Continue the interrupted task.\\n'+markers[0][0]});
  await prototypeReport($,{action,queued:typeof submitted.drop!=='string',step:markers[0][1]});
}
`
  source = source.replace(
    registration,
    `${helper}\n${registration}\non('session.start',async($,e,next)=>{$.ui.log('opka-prototype-loaded');void prototypeReport($,{action:'loaded'});return next(e)});`
  )
  writeFileSync(path, source, { mode: 0o600 })
  return {
    sha256: createHash('sha256').update(source).digest('hex'),
    failurePatched: source.includes("await prototypeWake($,'failure',e)"),
    promptPatched: source.includes("await prototypeWake($,'fresh-wake',e)")
  }
}

export function readNativePrintResultSummary(
  stdout: string,
  format: 'json' | 'stream-json'
): {
  valid: boolean
  resultCount: number
  errorCount: number
  lastError?: boolean
} {
  try {
    const parsed: unknown =
      format === 'json'
        ? JSON.parse(stdout)
        : stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
    const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    const results = rows.filter(
      (row) => !!row && typeof row === 'object' && 'type' in row && row.type === 'result'
    )
    const errorCount = results.filter(
      (row) => !!row && typeof row === 'object' && 'is_error' in row && row.is_error === true
    ).length
    const last = results.at(-1)
    return {
      valid: true,
      resultCount: results.length,
      errorCount,
      lastError:
        last && typeof last === 'object' && 'is_error' in last ? last.is_error === true : undefined
    }
  } catch {
    return { valid: false, resultCount: 0, errorCount: 0 }
  }
}
