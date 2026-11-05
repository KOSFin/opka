import parser, { type Token } from 'stream-json/core/parser.js'
import exec from 'stream-chain/exec.js'
import { none } from 'stream-chain/defs.js'

/** Bounds token batches while preserving caller-owned UTF-8 decoding. */
export function createJsonTokenReader(
  consume: (token: Token) => void,
  batchCodeUnits = 64 * 1024,
  retainScalar?: () => boolean,
  maxRetainedCodeUnits = Infinity
): {
  write: (text: string) => void
  end: () => void
} {
  if (!Number.isSafeInteger(batchCodeUnits) || batchCodeUnits < 1) {
    throw new RangeError('JSON token batch size must be a positive safe integer')
  }
  const parse = exec(
    parser({
      streamValues: false,
      packKeys: maxRetainedCodeUnits === Infinity,
      streamKeys: maxRetainedCodeUnits !== Infinity,
      packStrings: retainScalar === undefined && maxRetainedCodeUnits === Infinity,
      packNumbers: retainScalar === undefined && maxRetainedCodeUnits === Infinity,
      streamStrings: retainScalar !== undefined || maxRetainedCodeUnits !== Infinity,
      streamNumbers: retainScalar !== undefined || maxRetainedCodeUnits !== Infinity
    })
  )
  let scalar: 'string' | 'number' | 'key' | null = null
  let retained = false
  let value = ''
  const consumeToken = (token: Token): void => {
    if (token.name === 'startString' || token.name === 'startNumber' || token.name === 'startKey') {
      scalar =
        token.name === 'startKey' ? 'key' : token.name === 'startString' ? 'string' : 'number'
      retained = scalar === 'key' || (retainScalar?.() ?? true)
      value = ''
    } else if (token.name === 'stringChunk' || token.name === 'numberChunk') {
      if (retained) {
        if (value.length + token.value.length > maxRetainedCodeUnits) {
          throw new RangeError('Retained JSON scalar exceeds its bounded projection')
        }
        value += token.value
      }
    } else if (
      token.name === 'endString' ||
      token.name === 'endNumber' ||
      token.name === 'endKey'
    ) {
      const packed = value
      value = ''
      consume({
        name: scalar === 'key' ? 'keyValue' : scalar === 'number' ? 'numberValue' : 'stringValue',
        value: retained ? packed : scalar === 'number' ? '0' : ''
      })
      scalar = null
    } else {
      consume(token)
    }
  }
  function run(input: string | typeof none): void {
    let consumerFailed = false
    try {
      const pending = parse(input, (token: Token) => {
        try {
          consumeToken(token)
        } catch (error) {
          consumerFailed = true
          throw error
        }
      })
      if (pending) {
        throw new Error('JSON token reader requires a synchronous parser')
      }
    } catch (error) {
      if (!consumerFailed && error instanceof Error) {
        throw new SyntaxError(error.message)
      }
      throw error
    }
  }
  return {
    write(text) {
      for (let offset = 0; offset < text.length; offset += batchCodeUnits) {
        run(text.slice(offset, offset + batchCodeUnits))
      }
    },
    end() {
      run(none)
    }
  }
}
