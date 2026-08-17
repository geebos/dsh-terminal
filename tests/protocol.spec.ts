import { describe, expect, it } from 'vitest'
import { encodeFrame, parseClientFrame, isTerminalSignal } from '../src/protocol.ts'

describe('parseClientFrame', () => {
  it('accepts a well-formed attach frame', () => {
    const frame = parseClientFrame(JSON.stringify({
      type: 'attach', sessionId: 's1', tabId: 't1', replay: true, cols: 100, rows: 24,
    }))
    expect(frame).toEqual({ type: 'attach', sessionId: 's1', tabId: 't1', replay: true })
  })

  it('rejects malformed payloads', () => {
    expect(parseClientFrame('not json')).toBeUndefined()
    expect(parseClientFrame('null')).toBeUndefined()
    expect(parseClientFrame('42')).toBeUndefined()
    expect(parseClientFrame('{}')).toBeUndefined()
    expect(parseClientFrame(JSON.stringify({ type: 'unknown' }))).toBeUndefined()
  })

  it('rejects an attach frame with missing or mistyped members', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'attach', tabId: 't1', replay: true }))).toBeUndefined()
    expect(parseClientFrame(JSON.stringify({ type: 'attach', sessionId: 's1', replay: true }))).toBeUndefined()
    expect(parseClientFrame(JSON.stringify({ type: 'attach', sessionId: 's1', tabId: 't1' }))).toBeUndefined()
    expect(parseClientFrame(JSON.stringify({ type: 'attach', sessionId: '', tabId: 't1', replay: true }))).toBeUndefined()
    expect(parseClientFrame(JSON.stringify({ type: 'attach', sessionId: 's1', tabId: 't1', replay: 'yes' }))).toBeUndefined()
  })

  it('accepts whitelisted signals and rejects everything else', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'signal', signal: 'SIGINT' })))
      .toEqual({ type: 'signal', signal: 'SIGINT' })
    expect(parseClientFrame(JSON.stringify({ type: 'signal', signal: 'SIGUSR1' }))).toBeUndefined()
    expect(parseClientFrame(JSON.stringify({ type: 'signal', signal: 9 }))).toBeUndefined()
    expect(isTerminalSignal('SIGHUP')).toBe(true)
    expect(isTerminalSignal('SIGSTOP')).toBe(false)
  })

  it('validates resize numbers', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'resize', cols: 80, rows: 24 })))
      .toEqual({ type: 'resize', cols: 80, rows: 24 })
    expect(parseClientFrame(JSON.stringify({ type: 'resize', cols: '80', rows: 24 }))).toBeUndefined()
    expect(parseClientFrame(JSON.stringify({ type: 'resize', cols: NaN, rows: 24 }))).toBeUndefined()
  })
})

describe('encodeFrame', () => {
  it('round-trips server control frames as JSON text', () => {
    const text = encodeFrame({ type: 'exit', exitCode: 0 })
    expect(JSON.parse(text)).toEqual({ type: 'exit', exitCode: 0 })
    const error = encodeFrame({ type: 'error', code: 'RESIZE_UNSUPPORTED', message: 'no' })
    expect(JSON.parse(error)).toEqual({ type: 'error', code: 'RESIZE_UNSUPPORTED', message: 'no' })
  })
})
