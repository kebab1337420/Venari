import { describe, expect, it } from 'vitest'

import { isPrivateHost } from '../src/main/services/scan/plan'

describe('isPrivateHost', () => {
  it('reconnaît loopback, RFC1918, link-local et noms locaux', () => {
    for (const host of [
      '127.0.0.1',
      'localhost',
      'app.localhost',
      '10.0.0.3',
      '172.16.5.4',
      '172.31.255.254',
      '192.168.0.9',
      '169.254.169.254',
      '[::1]',
      '::1',
      'srv.internal',
      '169.254.1.1',
    ]) {
      expect(isPrivateHost(host), host).toBe(true)
    }
  })

  it('laisse passer un hôte public', () => {
    for (const host of ['example.com', '8.8.8.8', '203.0.113.7', '172.32.0.1', '11.0.0.1']) {
      expect(isPrivateHost(host), host).toBe(false)
    }
  })

  it('traite les IPv4 mappées en IPv6', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateHost('::ffff:7f00:1')).toBe(true)
    expect(isPrivateHost('::ffff:8.8.8.8')).toBe(false)
  })
})
