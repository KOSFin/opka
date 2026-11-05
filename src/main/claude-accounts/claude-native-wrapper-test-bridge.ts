import { resolve } from 'node:path'
import { build } from 'esbuild'

/** Run the production private CLI parsers against the isolated host's loopback RPC adapter. */
export async function buildClaudeNativeWrapperTestBridge(file: string, baseUrl: string) {
  await build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import {createRequire as fixtureRequire} from 'node:module'; const require=fixtureRequire(import.meta.url);"
    },
    outfile: file,
    stdin: {
      resolveDir: process.cwd(),
      contents: `import {runNativeClaudeCoverage} from ${JSON.stringify(resolve('src/cli/native-claude-coverage.ts'))};
import {runNativeClaudePoolHook} from ${JSON.stringify(resolve('src/cli/native-claude-pool-hook.ts'))};
const client={call:async(method,params)=>{const response=await fetch(method==='accounts.nativeClaudeCoverage'?${JSON.stringify(`${baseUrl}/coverage`)}:${JSON.stringify(`${baseUrl}/pool-hook`)},{method:'POST',body:JSON.stringify(params)});if(!response.ok)throw new Error('Synthetic account host unavailable');return{result:await response.json()}}};
process.exitCode=await (process.argv[3]==='native-pool-observe'?runNativeClaudeCoverage:runNativeClaudePoolHook)(client,process.argv.slice(4));`
    }
  })
}
