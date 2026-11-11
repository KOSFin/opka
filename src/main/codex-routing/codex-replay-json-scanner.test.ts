import { describe, expect, it } from 'vitest'
import { CodexReplayJsonScanner } from './codex-replay-json-scanner'

function scan(source: Buffer, chunkSize = 11) {
  const scanner = new CodexReplayJsonScanner()
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    scanner.write(source.subarray(offset, offset + chunkSize))
  }
  return scanner.finish()
}

describe('Codex replay JSON scanner', () => {
  it.each([
    ['first', '{"model":"probe","input":[{"model":"decoy"}],"stream":true}'],
    ['last', '{"input":[{"model":"decoy"}],"stream":true,"model":"probe"}'],
    ['escaped', '{"m\\u006fdel":"probe","input":[],"stream":false}']
  ])('selects the effective top-level model with byte offsets when %s', (_label, text) => {
    const source = Buffer.from(text)
    const result = scan(source)
    expect(result.model).toBe('probe')
    expect(source.subarray(result.modelStart, result.modelEnd).toString()).toBe('"probe"')
  })

  it('validates chunked UTF-8 and retains no image string in metadata', () => {
    const text = `{"input":[{"content":"🌊${'A'.repeat(20 * 1024 * 1024)}"}],"model":"probe"}`
    expect(scan(Buffer.from(text), 64 * 1024)).toMatchObject({ model: 'probe', stream: false })
  })

  it.each([
    '{"model":"a","model":"b"}',
    '{"model":"a","stream":true,"stream":false}',
    '{"model":"a","previous_response_id":"remote"}',
    '{"model":"a","input": [1,]}',
    '{"model":"a","input": {"x":1,}}',
    '{"model":"a","input": ["\\q"]}',
    '{"model":"a","input": [01]}',
    '{"model":"a","input": [1e]}',
    '{"model":"a","input": [true',
    '{"model":"a"}[]'
  ])('refuses malformed or ambiguous input before routing: %s', (text) => {
    expect(() => scan(Buffer.from(text))).toThrow()
  })

  it('rejects invalid UTF-8, deeply nested values and unbounded routing keys', () => {
    expect(() =>
      scan(
        Buffer.concat([
          Buffer.from('{"model":"a","input":"'),
          Buffer.from([0xff]),
          Buffer.from('"}')
        ])
      )
    ).toThrow()
    expect(() =>
      scan(Buffer.from(`{"model":"a","input":${'['.repeat(65)}0${']'.repeat(65)}}`))
    ).toThrow('nesting')
    expect(() => scan(Buffer.from(`{"${'x'.repeat(1025)}":1,"model":"a"}`))).toThrow('bounded')
  })
})
