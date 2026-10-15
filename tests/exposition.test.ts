import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'bountydesk-exposition-test-'))

let fakeInterfaces: Record<string, { address: string; family: string; internal: boolean }[]> = {}

// Seul networkInterfaces est simule : le reste de node:os (tmpdir) reste reel.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, networkInterfaces: () => fakeInterfaces }
})

const openedWindows: { id: number }[] = []

vi.mock('electron', () => {
  class FakeBrowserWindow {
    webContents = { id: openedWindows.length + 1 }
    on(): void {}
    show(): void {}
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    loadFile(): Promise<void> {
      return Promise.resolve()
    }
  }
  return {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    },
    ipcMain: { handle: vi.fn() },
    BrowserWindow: FakeBrowserWindow,
  }
})

vi.mock('../src/main/services/tools/installer', () => ({
  currentTools: async () => [],
  installTool: async (_id: string) => ({ ok: true as const, installed: true }),
  resolveBinary: () => null,
  resolveWordlist: () => null,
  toolsDir: () => userData,
}))

import { getMcpStatus, startMcpServer, stopMcpServer } from '../src/main/services/mcp/server'
import { getViewTokenForSender, openAgentView } from '../src/main/view'

const TOKEN = 'test-token-exposition-1234567890'

function onlyAddresses(addrs: { address: string; family: string; internal: boolean }[]): void {
  fakeInterfaces = { eth0: addrs }
}

describe('exposition reseau du serveur MCP', () => {
  afterEach(async () => {
    await stopMcpServer()
  })

  it('refuse 0.0.0.0 sur un reseau public, meme demande explicitement', async () => {
    onlyAddresses([{ address: '203.0.113.7', family: 'IPv4', internal: false }])
    const r = await startMcpServer(0, TOKEN, { lan: true })
    expect(r.ok).toBe(true)
    expect(getMcpStatus().lan).toBe(false)
  })

  it('refuse 0.0.0.0 sur un reseau public sans interface du tout', async () => {
    fakeInterfaces = {}
    await startMcpServer(0, TOKEN, { lan: true })
    expect(getMcpStatus().lan).toBe(false)
  })

  it('accepte 0.0.0.0 sur un reseau prive', async () => {
    onlyAddresses([{ address: '192.168.1.42', family: 'IPv4', internal: false }])
    await startMcpServer(0, TOKEN, { lan: true })
    expect(getMcpStatus().lan).toBe(true)
  })

  it('accepte les trois plages privees et refuse 172.15/172.32', async () => {
    for (const address of ['10.1.2.3', '172.16.0.9', '172.31.255.254', '192.168.0.1']) {
      onlyAddresses([{ address, family: 'IPv4', internal: false }])
      await startMcpServer(0, TOKEN, { lan: true })
      expect(getMcpStatus().lan).toBe(true)
    }
    for (const address of ['172.15.0.1', '172.32.0.1', '203.0.113.7']) {
      onlyAddresses([{ address, family: 'IPv4', internal: false }])
      await startMcpServer(0, TOKEN, { lan: true })
      expect(getMcpStatus().lan).toBe(false)
    }
  })
})

describe('jeton de vue distante', () => {
  it('n’est servi qu’a la fenetre de vue ouverte par le processus principal', () => {
    expect(getViewTokenForSender(9999)).toBeNull()
    openAgentView('jeton-de-vue-1', 'PC distant')
    expect(getViewTokenForSender(1)).toBe('jeton-de-vue-1')
    // Une autre fenetre (la fenetre principale) n'obtient rien.
    expect(getViewTokenForSender(2)).toBeNull()
  })
})