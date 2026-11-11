import type { HandlerGroup } from './handler-group-manifest'

export const NATIVE_AGENT_HANDLER_GROUP: HandlerGroup = {
  name: 'native-agent-exec',
  keys: [
    'agent native-exec',
    'agent native-attach',
    'agent native-pool-hook',
    'agent native-pool-observe',
    'agent native-home status',
    'agent native-home apply',
    'agent native-shell status',
    'agent native-shell install',
    'agent native-shell uninstall'
  ],
  load: async () => (await import('./handlers/native-agent-exec.js')).NATIVE_AGENT_EXEC_HANDLERS
}
