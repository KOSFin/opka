import { describe, expect, it } from 'vitest'
import { dropInheritedOrcaHistFile, isOrcaMintedHistFile } from './worktree-history-file-path'

describe('inherited terminal history ownership', () => {
  it.each(['orca', 'opka'])('recognises the %s remote namespace without reading files', (name) => {
    const env = {
      HISTFILE: `/home/test/.${name}-remote/terminal-history/0123456789abcdef-zsh_history`
    }
    expect(isOrcaMintedHistFile(env.HISTFILE)).toBe(true)
    dropInheritedOrcaHistFile(env)
    expect(env.HISTFILE).toBeUndefined()
  })
  it('keeps user-selected and relative history paths', () => {
    for (const path of [
      '/home/test/.zsh_history',
      '.opka-remote/terminal-history/0123456789abcdef-zsh_history'
    ]) {
      const env = { HISTFILE: path }
      dropInheritedOrcaHistFile(env)
      expect(env.HISTFILE).toBe(path)
    }
  })
})
