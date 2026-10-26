export type ProjectTaskAgentSettings = {
  enabled: boolean
  state: 'enabled' | 'disabled' | 'needs-repair' | 'customized'
  files: { path: string; state: 'installed' | 'missing' | 'customized' }[]
}
