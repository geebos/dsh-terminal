import { describe, expect, it } from 'vitest'
import { isTrustedUpgrade } from '../src/terminal-ws.ts'

const BOUND = '127.0.0.1'

describe('isTrustedUpgrade', () => {
  it('accepts a same-origin loopback browser handshake', () => {
    expect(isTrustedUpgrade({
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
    }, BOUND)).toBe(true)
    expect(isTrustedUpgrade({
      host: 'localhost:9000',
      origin: 'http://localhost:9000',
    }, BOUND)).toBe(true)
  })

  it('refuses a missing Origin (browsers always send one on WebSocket)', () => {
    expect(isTrustedUpgrade({ host: '127.0.0.1:3080' }, BOUND)).toBe(false)
  })

  it('refuses a cross-origin Origin (CSWSH)', () => {
    expect(isTrustedUpgrade({
      host: '127.0.0.1:3080',
      origin: 'http://evil.example',
    }, BOUND)).toBe(false)
    expect(isTrustedUpgrade({
      host: '127.0.0.1:3080',
      origin: 'null',
    }, BOUND)).toBe(false)
  })

  it('refuses a cross-site sec-fetch marker even with a matching Origin', () => {
    expect(isTrustedUpgrade({
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'sec-fetch-site': 'cross-site',
    }, BOUND)).toBe(false)
  })

  it('refuses a non-loopback Host (DNS rebinding)', () => {
    expect(isTrustedUpgrade({
      host: 'attacker.example:3080',
      origin: 'http://attacker.example:3080',
    }, BOUND)).toBe(false)
  })

  it('refuses a missing or unparsable Host', () => {
    expect(isTrustedUpgrade({ origin: 'http://127.0.0.1:3080' }, BOUND)).toBe(false)
    expect(isTrustedUpgrade({ host: '', origin: 'http://127.0.0.1:3080' }, BOUND)).toBe(false)
  })

  it('accepts the bound literal when it is not loopback', () => {
    expect(isTrustedUpgrade({
      host: '192.168.1.5:3080',
      origin: 'http://192.168.1.5:3080',
    }, '192.168.1.5')).toBe(true)
  })
})
