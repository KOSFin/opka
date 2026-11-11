import { describe, expect, it } from 'vitest'
import { normalizeGitHttpsHost } from './git-https-host'

describe('Git HTTPS authority normalization', () => {
  it.each([
    ['GitLab.COM', 'gitlab.com'],
    ['gitlab.com:443', 'gitlab.com'],
    ['gitlab.example:8443', 'gitlab.example:8443'],
    ['Bücher.example', 'xn--bcher-kva.example'],
    ['127.0.0.1:8443', '127.0.0.1:8443']
  ])('canonicalizes %s', (input, expected) => {
    expect(normalizeGitHttpsHost(input)).toBe(expected)
  })

  it.each([
    'https://gitlab.example',
    'gitlab.example/',
    'alice@gitlab.example',
    'gitlab.example:0',
    'gitlab.example:65536',
    'gitlab.example:0443',
    'gitlab.example.',
    'gitlab..example',
    '127.1',
    '[::1]',
    'gitlab.example%2felsewhere',
    'gitlab.example\\elsewhere',
    'gitlab.example?token',
    'gitlab.example#fragment',
    ' gitlab.example',
    'gitlab.example\n'
  ])('refuses ambiguous host %s', (input) => {
    expect(normalizeGitHttpsHost(input)).toBeNull()
  })
})
