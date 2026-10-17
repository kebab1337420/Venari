import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, ChildProcess } from 'node:child_process'
import WebSocket from 'ws'
import { exeSuffix } from '../src/main/services/tools/platform'

const userData = mkdtempSync(join(tmpdir(), 'bountydesk-agentrust-test-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../src/main/services/tools/installer', () => ({
  currentTools: async () => [],
  installTool: async (_id: string) => ({ ok: true as const, installed: true }),
  resolveBinary: () => null,
  resolveWordlist: () => null,
  toolsDir: () => userData,
}))

import { closeDb, getRepository } from '../src/main/db'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcp/server'
import {
  agentStatuses,
  decideSession,
  requestSession,
} from '../src/main/services/mcp/agents'

const TOKEN = 'test-token-http-1234567890'
const AGENT_TOKEN = 'agent-token-rust-123456789'
const AGENT_ID = 'agent-rust'
let port = 0

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor<T>(fn: () => T | null, timeout = 8000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const v = fn()
    if (v) return v
    await sleep(120)
  }
  throw new Error('timeout attente condition')
}

// L'agent Rust est un binaire séparé, compilé pour une seule plateforme :
// ce test ne peut tourner que s'il existe (cargo build --release dans remote-agent/).
// Sans ce garde-fou, `npm test` échoue sur toute machine où il n'est pas buildé.
const agentBinName = `bountydesk-agent${exeSuffix()}`
const agentBin = join(__dirname, '../remote-agent/target/release', agentBinName)
const agentBuilt = existsSync(agentBin)

describe.skipIf(!agentBuilt)('agent rust (binaire réel)', () => {
  beforeEach(async () => {
    closeDb()
    rmSync(join(userData, 'bountydesk.db'), { force: true })
    rmSync(join(userData, 'bountydesk.db-wal'), { force: true })
    rmSync(join(userData, 'bountydesk.db-shm'), { force: true })
    getRepository()
    const r = await startMcpServer(0, TOKEN, {
      discoveryPort: 0,
      agentTokens: [{ id: AGENT_ID, label: 'Agent Rust', token: AGENT_TOKEN }],
    })
    if (!r.ok) throw new Error(r.error)
    port = r.port
  })

  afterEach(() => {
    stopMcpServer()
  })

  it('l’exe agent se connecte, est marqué en ligne et répond au startStream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-exe-'))
    // l'agent lit son config.json à côté de son propre binaire, pas dans le cwd :
    // il faut donc l'exécuter depuis un dossier jetable qui contient les deux.
    const exe = join(dir, agentBinName)
    copyFileSync(agentBin, exe)
    if (process.platform !== 'win32') chmodSync(exe, 0o755)
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ server: '127.0.0.1', port, token: AGENT_TOKEN, fps: 5 }),
      { flag: 'w' }
    )

    const child: ChildProcess = spawn(exe, [], { cwd: dir, stdio: 'ignore', detached: false })
    try {
      await waitFor(() => {
        const st = agentStatuses()
        return st.find((s) => s.id === AGENT_ID && s.online) ?? null
      })

      const status = agentStatuses().find((s) => s.id === AGENT_ID)!
      expect(status.hostname).toBeTruthy()

      const req = requestSession(AGENT_ID)
      expect('row' in req).toBe(true)
      if (!('row' in req)) return
      const decided = decideSession(req.row.id, true)
      expect(decided.ok).toBe(true)
      if (!decided.ok) return

      const log = await waitFor(() => {
        try {
          const text = require('node:fs').readFileSync(join(dir, 'agent.log'), 'utf8')
          return text.includes('startStream') ? text : null
        } catch {
          return null
        }
      })
      expect(log).toContain('startStream')

      const viewer = new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/view?token=${decided.viewToken}`)
        const frames: Buffer[] = []
        const t = setTimeout(() => reject(new Error('timeout frames viewer')), 10000)
        ws.on('message', (data) => {
          if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            frames.push(Buffer.from(data as ArrayBuffer))
            if (frames.length >= 2) {
              clearTimeout(t)
              ws.close()
              resolve()
            }
          }
        })
        ws.on('error', (e) => {
          clearTimeout(t)
          reject(e)
        })
      })
      await viewer
    } finally {
      child.kill()
    }
  }, 25000)
})