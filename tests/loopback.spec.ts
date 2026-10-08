import { describe, expect, it } from 'vitest'
import { hostIsTrusted, originIsTrusted, requestIsTrusted } from '../src/loopback.ts'
import { openAuthUrl } from '../src/oauth.ts'

describe('request trust', () => {
  it('accepts loopback with no extra hosts', () => {
    expect(hostIsTrusted('127.0.0.1:3080')).toBe(true)
    expect(originIsTrusted('http://127.0.0.1:3080')).toBe(true)
    expect(requestIsTrusted({ headers: { host: 'localhost:3080' } })).toBe(true)
  })

  it('rejects a LAN host until it is listed', () => {
    expect(hostIsTrusted('192.168.1.10:3080')).toBe(false)
    expect(hostIsTrusted('192.168.1.10:3080', ['192.168.1.10'])).toBe(true)
    expect(originIsTrusted('http://192.168.1.10:3080', ['192.168.1.10'])).toBe(true)
    expect(requestIsTrusted(
      { headers: { host: '192.168.1.10:3080', origin: 'http://evil.example' } },
      ['192.168.1.10'],
    )).toBe(false)
  })

  it('does not treat an unlisted rebinding Host as trusted', () => {
    expect(hostIsTrusted('attacker.example', ['192.168.1.10'])).toBe(false)
  })
})

describe('openAuthUrl', () => {
  it('does not throw when the browser helper is missing', () => {
    expect(() => openAuthUrl('https://www.workbuddy.ai/login')).not.toThrow()
  })
})
