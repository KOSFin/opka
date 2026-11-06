import { expect, it } from 'vitest'
import { codexRoutingFailureMessage } from './codex-routing-failure'

it('distinguishes local engine transport errors from account admission without leaking error text', () => {
  const error = Object.assign(new Error('private credential and request body'), {
    code: 'ECONNRESET'
  })
  expect(codexRoutingFailureMessage(error, 'engine-headers')).toContain('engine-headers/ECONNRESET')
  expect(codexRoutingFailureMessage(error, 'admission')).toContain('admission/ECONNRESET')
  expect(codexRoutingFailureMessage(error, 'engine-body')).not.toContain('private')
})
it('does not print arbitrary provider codes, messages, URLs or non-Error values', () => {
  const error = Object.assign(new Error('https://private.invalid/?secret=credential'), {
    code: 'private-code'
  })
  expect(codexRoutingFailureMessage(error, 'engine-body')).toContain('engine-body/UNCLASSIFIED')
  expect(codexRoutingFailureMessage(error, 'engine-body')).not.toContain('private')
  expect(codexRoutingFailureMessage({ code: 'ECONNRESET' }, 'admission')).toContain(
    'admission/UNCLASSIFIED'
  )
})
