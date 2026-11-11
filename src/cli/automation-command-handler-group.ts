import type { HandlerGroup } from './handler-group-manifest'

export const AUTOMATION_COMMAND_HANDLER_GROUP: HandlerGroup = {
  name: 'automation-command',
  keys: [
    'automations command list',
    'automations command show',
    'automations command create',
    'automations command edit',
    'automations command remove',
    'automations command run',
    'automations command cancel',
    'automations command runs'
  ],
  load: async () =>
    (await import('./handlers/automation-command-handlers.js')).AUTOMATION_COMMAND_MODE_HANDLERS
}
