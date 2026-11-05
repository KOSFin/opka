import { expect, it } from 'vitest'
import { nativeCodexLaunchContext } from '../shared/native-codex-launch-context'

it.each([
  ['--profile', 'native', '--config', 'model_provider="other"', '--cd', 'project'],
  ['--profile=native', '--config=model_provider="other"', '--cd=project'],
  ['-pnative', '-cmodel_provider="other"', '-Cproject'],
  ['-p=native', '-c=model_provider="other"', '-C=project']
])('extracts actual semantic context from supported native flag spellings', (...args) => {
  expect(nativeCodexLaunchContext(args, '/synthetic')).toEqual({
    codexProfile: 'native',
    codexModelProvider: 'other',
    codexWorkingDirectory: '/synthetic/project'
  })
})

it('keeps prompts and unrelated configuration out of the host context', () => {
  const context = nativeCodexLaunchContext(
    [
      'exec',
      '-m',
      'resume',
      '-c',
      'mcp_servers.private.env.SECRET="synthetic-secret"',
      '--',
      '-p',
      'private-prompt'
    ],
    '/synthetic'
  )
  expect(context).toEqual({ codexWorkingDirectory: '/synthetic' })
  expect(JSON.stringify(context)).not.toContain('synthetic-secret')
})

it('resolves the final catalog choice against the native working directory', () => {
  expect(
    nativeCodexLaunchContext(
      [
        '-c',
        'model_catalog_json="first.json"',
        '--cd',
        'project',
        '-c',
        'model_catalog_json="last.json"'
      ],
      '/synthetic'
    )
  ).toEqual({
    codexWorkingDirectory: '/synthetic/project',
    codexModelCatalogPath: '/synthetic/project/last.json'
  })
})

it('identifies an explicit native resume UUID without forwarding other positionals', () => {
  const id = '01a19cbe-8911-7312-a6d8-a90e22b7d17a'
  expect(
    nativeCodexLaunchContext(['exec', 'resume', id, 'synthetic prompt'], '/synthetic')
      .codexResumeSessionId
  ).toBe(id)
})
