import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { createSocket } from 'node:dgram'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'venari-mcp-pairing-test-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { handle: vi.fn() },
  clipboard: { writeText: vi.fn() },
  Notification: class {
    on(): void {}
    show(): void {}
  },
}))

vi.mock('../src/main/services/tools/installer', () => ({
  currentTools: async () => [],
  installTool: async () => ({ ok: true as const, installed: true }),
  resolveBinary: () => null,
  resolveWordlist: () => null,
  toolsDir: () => userData,
}))

import { closeDb, getRepository } from '../src/main/db'
import { DISCOVERY_PROBE } from '../src/main/services/mcp/discover'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcp/server'
import { registerMcpIpc } from '../src/main/ipc-mcp'
import { IPC } from '../src/shared/ipc'
import { ipcMain } from 'electron'
import type { ProgramInput } from '../src/main/db/repo'

const ipcHandlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

function captureIpc(): void {
  for (const [channel, handler] of vi.mocked(ipcMain.handle).mock.calls) {
    ipcHandlers[channel as string] = handler as (...args: unknown[]) => Promise<unknown>
  }
}

function ipcHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const handler = ipcHandlers[channel]
  if (!handler) throw new Error(`IPCHandler ${channel} non enregistré`)
  return handler
}

const TOKEN = 'test-token-pairing-123456'
let port = 0
let discoveryPort = 0

async function pair(code: string, overrides: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    ...overrides,
  })
}

async function ping(token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
}

/** Sonde le repondeur de decouverte en unicast loopback (pas besoin de multicast en test). */
function probeDiscovery(): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const sock = createSocket('udp4')
    let done = false
    const finish = (value: Record<string, unknown> | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        // deja ferme
      }
      resolve(value)
    }
    sock.on('message', (msg) => {
      try {
        finish(JSON.parse(msg.toString('utf8')) as Record<string, unknown>)
      } catch {
        finish(null)
      }
    })
    sock.on('error', () => finish(null))
    sock.bind(0, '127.0.0.1', () => {
      const probe = Buffer.from(JSON.stringify({ probe: DISCOVERY_PROBE }))
      sock.send(probe, discoveryPort, '127.0.0.1', () => {})
    })
    const timer = setTimeout(() => finish(null), 5000)
  })
}

describe('appairage MCP (HTTP réel)', () => {
  beforeAll(() => {
    registerMcpIpc()
    captureIpc()
  })

  beforeEach(async () => {
    closeDb()
    getRepository().upsertPrograms([
      {
        id: 'prog-1', handle: 'acme', name: 'Acme', type: 'bug_bounty', status: 'active',
        confidentiality: 'public', minBounty: null, maxBounty: null, industry: null,
        webLink: null, following: false, rawJson: null,
      } as ProgramInput,
    ])
    const r = await startMcpServer(0, TOKEN, { discoveryPort: 0 })
    if (!r.ok) throw new Error(r.error)
    port = r.port
    discoveryPort = r.discoveryPort
  })

  afterEach(() => {
    stopMcpServer()
  })

  it('expose un document de découverte public, sans jeton', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/venari.json`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { app: string; pairId: string; port: number; mcp: string; pairing: boolean }
    expect(json.app).toBe('Venari')
    expect(json.pairId).toBeTypeOf('string')
    expect(json.pairId.length).toBeGreaterThan(0)
    expect(json.port).toBe(port)
    expect(json.mcp).toBe('/mcp')
    expect(json.pairing).toBe(true)
    expect(JSON.stringify(json)).not.toContain(TOKEN)
  })

  it('découvre le serveur via la sonde UDP', async () => {
    const reply = await probeDiscovery()
    expect(reply).toBeTruthy()
    expect(reply?.app).toBe('Venari')
    expect(reply?.port).toBe(port)
    expect(reply?.pairId).toBeTypeOf('string')
  })

  it('génère un code, l’échange contre un jeton utilisable, puis le consomme', async () => {
    const created = (await ipcHandler(IPC.McpPairingCreate)()) as {
      ok: true
      pairing: { code: string; pairId: string; port: number | null }
    }
    expect(created.ok).toBe(true)
    expect(created.pairing.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/)
    expect(created.pairing.port).toBe(port)

    const res = await pair(created.pairing.code)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; token: string; label: string }
    expect(body.ok).toBe(true)
    expect(body.token.length).toBeGreaterThan(20)

    // Le jeton fraîchement appairé est actif sans redémarrage du serveur.
    const pong = await ping(body.token)
    expect(pong.status).toBe(200)

    // Usage unique : le même code ne sert plus.
    const replay = await pair(created.pairing.code)
    expect(replay.status).toBe(400)
  })

  it('refuse un mauvais code sans révéler de jeton', async () => {
    await ipcHandler(IPC.McpPairingCreate)()
    const res = await pair('ZZZZZZ')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; error: string; token?: string }
    expect(body.ok).toBe(false)
    expect(body.token).toBeUndefined()
  })

  it('refuse l’appairage quand le serveur n’est pas actif', async () => {
    stopMcpServer()
    const res = (await ipcHandler(IPC.McpPairingCreate)()) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/serveur MCP/i)
  })

  it('annule un code en attente', async () => {
    await ipcHandler(IPC.McpPairingCreate)()
    await ipcHandler(IPC.McpPairingCancel)()
    const res = await pair('ZZZZZZ')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Aucun code/i)
  })

  it('répond 405 sur /pair hors POST', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/pair`)
    expect(res.status).toBe(405)
  })
})
