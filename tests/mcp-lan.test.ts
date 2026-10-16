import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(join(tmpdir(), 'bountydesk-lan-')) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { handle: vi.fn() },
}))

const netInterfaces = vi.hoisted(() => vi.fn())

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, networkInterfaces: netInterfaces, default: { ...actual, networkInterfaces: netInterfaces } }
})

import { isPrivateNetwork } from '../src/main/services/mcp/server'

function addr(address: string, internal = false, family = 'IPv4') {
  return { address, family, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` }
}

describe('isPrivateNetwork', () => {
  beforeEach(() => netInterfaces.mockReset())

  it('vrai seulement si toutes les interfaces non-internes sont RFC1918', () => {
    netInterfaces.mockReturnValue({
      eth0: [addr('192.168.1.42'), addr('10.0.0.5')],
      lo: [addr('127.0.0.1', true)],
    })
    expect(isPrivateNetwork()).toBe(true)
  })

  it('faux dès qu’une interface porte une adresse publique', () => {
    netInterfaces.mockReturnValue({
      eth0: [addr('192.168.1.42'), addr('203.0.113.7')],
    })
    expect(isPrivateNetwork()).toBe(false)
  })

  it('faux si aucune interface non-interne exploitable', () => {
    netInterfaces.mockReturnValue({ lo: [addr('127.0.0.1', true)] })
    expect(isPrivateNetwork()).toBe(false)
    netInterfaces.mockReturnValue({})
    expect(isPrivateNetwork()).toBe(false)
  })
})
