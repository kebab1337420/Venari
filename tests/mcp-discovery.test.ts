import { EventEmitter } from 'node:events'
import type { Socket } from 'node:dgram'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dgram = vi.hoisted(() => ({ createSocket: vi.fn() }))
vi.mock('node:dgram', () => dgram)

import {
  DISCOVERY_GROUP,
  DISCOVERY_PROBE,
  startDiscoveryResponder,
  stopDiscoveryResponder,
} from '../src/main/services/mcp/discover'

interface RInfo {
  address: string
  port: number
}

class FakeSocket extends EventEmitter {
  bind = vi.fn<(port: number, cb?: () => void) => void>()
  send = vi.fn<(buf: Buffer, port: number, address: string, cb: () => void) => void>()
  close = vi.fn<() => void>()
  addMembership = vi.fn<(group: string) => void>()
  address = vi.fn<() => { port: number }>()

  constructor() {
    super()
    this.address.mockReturnValue({ port: 0 })
    this.bind.mockImplementation((port: number, cb?: () => void) => {
      this.address.mockReturnValue({ port })
      cb?.()
    })
    this.addMembership.mockImplementation(() => undefined)
    this.send.mockImplementation(() => undefined)
    this.close.mockImplementation(() => undefined)
  }
}

let sockets: FakeSocket[] = []

beforeEach(() => {
  sockets = []
  dgram.createSocket.mockImplementation(() => {
    const s = new FakeSocket()
    sockets.push(s)
    return s as unknown as Socket
  })
})

afterEach(() => {
  stopDiscoveryResponder()
  vi.clearAllMocks()
})

const rinfo = (over: Partial<RInfo> = {}): RInfo => ({ address: '192.0.2.10', port: 41000, ...over })
const probe = (): Buffer => Buffer.from(JSON.stringify({ probe: DISCOVERY_PROBE }))

describe('startDiscoveryResponder', () => {
  it('ecoute le port demande et rejoint le groupe multicast', async () => {
    await startDiscoveryResponder(() => ({ ok: true }), 5000)
    expect(dgram.createSocket).toHaveBeenCalledWith({ type: 'udp4', reuseAddr: true })
    expect(sockets[0].bind).toHaveBeenCalledWith(5000, expect.any(Function))
    expect(sockets[0].addMembership).toHaveBeenCalledWith(DISCOVERY_GROUP)
  })

  it('resout le port reellement lie (port ephemere)', async () => {
    dgram.createSocket.mockImplementation(() => {
      const s = new FakeSocket()
      s.bind.mockImplementation((_port: number, cb?: () => void) => cb?.())
      s.address.mockReturnValue({ port: 45678 })
      sockets.push(s)
      return s as unknown as Socket
    })
    await expect(startDiscoveryResponder(() => ({}), 0)).resolves.toBe(45678)
  })

  it('repond a une sonde valide avec la charge courante', async () => {
    await startDiscoveryResponder(() => ({ pairId: 'abc', port: 7777 }), 5000)
    sockets[0].emit('message', probe(), rinfo())

    expect(sockets[0].send).toHaveBeenCalledTimes(1)
    const [payload, port, address] = sockets[0].send.mock.calls[0]!
    expect(port).toBe(41000)
    expect(address).toBe('192.0.2.10')
    expect(JSON.parse(payload.toString('utf8'))).toEqual({ pairId: 'abc', port: 7777 })
  })

  it('ignore un message qui n est pas du JSON', async () => {
    await startDiscoveryResponder(() => ({}), 5000)
    sockets[0].emit('message', Buffer.from('pas du json'), rinfo())
    expect(sockets[0].send).not.toHaveBeenCalled()
  })

  it('ignore une sonde etrangere', async () => {
    await startDiscoveryResponder(() => ({}), 5000)
    sockets[0].emit('message', Buffer.from(JSON.stringify({ probe: 'autre-chose' })), rinfo())
    expect(sockets[0].send).not.toHaveBeenCalled()
  })

  it('ignore un message sans champ probe', async () => {
    await startDiscoveryResponder(() => ({}), 5000)
    sockets[0].emit('message', Buffer.from(JSON.stringify({ hello: 'world' })), rinfo())
    expect(sockets[0].send).not.toHaveBeenCalled()
  })

  it('ferme la socket et resout sur erreur', async () => {
    const port = startDiscoveryResponder(() => ({}), 5000)
    const s = sockets[0]
    s.emit('error', new Error('port indisponible'))
    await expect(port).resolves.toBe(5000)
    expect(s.close).toHaveBeenCalledTimes(1)
  })

  it('remplace une reponse deja active', async () => {
    await startDiscoveryResponder(() => ({}), 5000)
    const first = sockets[0]
    await startDiscoveryResponder(() => ({}), 5001)
    expect(sockets).toHaveLength(2)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(sockets[1].bind).toHaveBeenCalledWith(5001, expect.any(Function))
  })

  it('supporte une interface sans multicast', async () => {
    dgram.createSocket.mockImplementation(() => {
      const s = new FakeSocket()
      s.addMembership.mockImplementation(() => {
        throw new Error('multicast indisponible')
      })
      sockets.push(s)
      return s as unknown as Socket
    })
    await expect(startDiscoveryResponder(() => ({}), 5000)).resolves.toBe(5000)
  })
})

describe('stopDiscoveryResponder', () => {
  it('ferme la socket active', async () => {
    await startDiscoveryResponder(() => ({}), 5000)
    stopDiscoveryResponder()
    expect(sockets[0].close).toHaveBeenCalledTimes(1)
  })

  it('est sans effet quand rien n ecoute', () => {
    expect(() => stopDiscoveryResponder()).not.toThrow()
  })

  it('ne ferme qu une fois la socket', async () => {
    await startDiscoveryResponder(() => ({}), 5000)
    stopDiscoveryResponder()
    stopDiscoveryResponder()
    expect(sockets[0].close).toHaveBeenCalledTimes(1)
  })
})
