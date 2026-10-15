import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const userData = mkdtempSync(join(tmpdir(), 'bountydesk-agents-test-'))

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
  agentEntryByToken,
  agentSessions,
  agentStatuses,
  decideSession,
  endSessionByViewToken,
  requestSession,
  sweepStaleSessions,
} from '../src/main/services/mcp/agents'

const TOKEN = 'test-token-http-1234567890'
const AGENT_TOKEN = 'agent-token-test-123456'
const AGENT_ID = 'agent-1'
let port = 0

type InboxEntry = unknown

interface Link {
  ws: WebSocket
  inbox: InboxEntry[]
}

function makeInbox(ws: WebSocket): InboxEntry[] {
  const inbox: InboxEntry[] = []
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    inbox.push(isBinary ? data : JSON.parse(data.toString()))
  })
  return inbox
}

function waitInbox<T = unknown>(inbox: InboxEntry[], timeout = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (inbox.length > 0) {
      resolve(inbox.shift() as T)
      return
    }
    const t = setTimeout(() => reject(new Error('timeout en attente de message')), timeout)
    const id = setInterval(() => {
      if (inbox.length > 0) {
        clearInterval(id)
        clearTimeout(t)
        resolve(inbox.shift() as T)
      }
    }, 10)
  })
}

function connectAgent(token?: string): Promise<Link> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    const inbox = makeInbox(ws)
    ws.once('open', () => resolve({ ws, inbox }))
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`upgrade refusé HTTP ${res.statusCode}`))
    })
    ws.once('error', (err) => reject(err))
  })
}

function connectAgentViaUrl(token: string): Promise<Link> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${token}`)
    const inbox = makeInbox(ws)
    ws.once('open', () => resolve({ ws, inbox }))
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`upgrade refusé HTTP ${res.statusCode}`))
    })
    ws.once('error', (err) => reject(err))
  })
}

function connectViewer(viewToken: string): Promise<Link> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/view?token=${viewToken}`)
    const inbox = makeInbox(ws)
    ws.once('open', () => resolve({ ws, inbox }))
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`upgrade refusé HTTP ${res.statusCode}`))
    })
    ws.once('error', (err) => reject(err))
  })
}

describe('vision distante (agent WS + sessions)', () => {
  beforeEach(async () => {
    closeDb()
    rmSync(join(userData, 'bountydesk.db'), { force: true })
    rmSync(join(userData, 'bountydesk.db-wal'), { force: true })
    rmSync(join(userData, 'bountydesk.db-shm'), { force: true })
    getRepository()
    const r = await startMcpServer(0, TOKEN, {
      agentTokens: [{ id: AGENT_ID, label: 'Boite', token: AGENT_TOKEN }],
    })
    if (!r.ok) throw new Error(r.error)
    port = r.port
  })

  afterEach(() => {
    stopMcpServer()
  })

  it('migration v6 : table remote_sessions présente', () => {
    expect(getRepository().listRemoteSessions(5)).toEqual([])
  })

  it('refuse l’agent sans jeton ou avec un mauvais jeton (HTTP 401)', async () => {
    await expect(connectAgent()).rejects.toThrow('401')
    await expect(connectAgent('mauvais-jeton')).rejects.toThrow('401')
  })

  it('refuse un jeton passé dans l’URL (le jeton ne voyage que dans le header)', async () => {
    await expect(connectAgentViaUrl(AGENT_TOKEN)).rejects.toThrow('401')
  })

  it('accueille un agent avec un jeton valide et le marque en ligne', async () => {
    const agent = await connectAgent(AGENT_TOKEN)
    const welcome = (await waitInbox(agent.inbox)) as unknown as { type: string; label: string }
    expect(welcome.type).toBe('welcome')
    expect(welcome.label).toBe('Boite')
    const status = agentStatuses()
    expect(status[0]).toMatchObject({ id: AGENT_ID, label: 'Boite', online: true })
    agent.ws.close()
  })

  it('flux de session complet : demande → validation → flux → fermeture', async () => {
    const agent = await connectAgent(AGENT_TOKEN)
    await waitInbox(agent.inbox) // welcome

    const req = requestSession(AGENT_ID)
    if (!('row' in req)) throw new Error('session non créée')
    const sessionId = req.row.id
    expect(req.row.status).toBe('pending')
    expect(req.row.remoteIp).toBe('127.0.0.1')

    expect(agentSessions().find((s) => s.id === sessionId)?.status).toBe('pending')

    const decided = decideSession(sessionId, true)
    if (!decided.ok) throw new Error('session non validée')
    expect((await waitInbox(agent.inbox)) as unknown as { type: string }).toMatchObject({
      type: 'startStream',
    })

    const viewer = await connectViewer(decided.viewToken!)
    agent.ws.send(JSON.stringify({ type: 'dims', width: 1280, height: 720 }))
    const start = (await waitInbox(viewer.inbox)) as unknown as {
      type: string
      width: number
      height: number
    }
    expect(start).toMatchObject({ type: 'start', width: 1280, height: 720 })

    agent.ws.send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const frame = (await waitInbox(viewer.inbox)) as Buffer
    expect(frame.equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true)

    viewer.ws.send(
      JSON.stringify({ type: 'input', events: [{ type: 'mousemove', x: 0.5, y: 0.5 }] }),
    )
    const inputMsg = (await waitInbox(agent.inbox)) as unknown as {
      type: string
      events: { type: string }[]
    }
    expect(inputMsg.type).toBe('input')
    expect(inputMsg.events[0]!.type).toBe('mousemove')

    viewer.ws.close()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(agentSessions().find((s) => s.id === sessionId)?.status).toBe('ended')

    agent.ws.close()
  })

  it('demande de session refusée → status refused', async () => {
    const agent = await connectAgent(AGENT_TOKEN)
    await waitInbox(agent.inbox)
    const req = requestSession(AGENT_ID)
    if (!('row' in req)) throw new Error('session non créée')
    const decided = decideSession(req.row.id, false)
    if (!decided.ok) throw new Error('échec refuse')
    expect(agentSessions().find((s) => s.id === req.row.id)?.status).toBe('refused')
    agent.ws.close()
  })

  it('session imbisible tant qu’un viewer est actif (statut busy)', async () => {
    const agent = await connectAgent(AGENT_TOKEN)
    await waitInbox(agent.inbox)
    const req = requestSession(AGENT_ID)
    if (!('row' in req)) throw new Error('session non créée')
    const decided = decideSession(req.row.id, true)
    if (!decided.ok) throw new Error('échec approve')
    await waitInbox(agent.inbox) // startStream
    const viewer = await connectViewer(decided.viewToken!)
    const second = requestSession(AGENT_ID)
    expect('busy' in second).toBe(true)
    viewer.ws.close()
    agent.ws.close()
  })

  it('endSessionByViewToken termine la session active', async () => {
    const agent = await connectAgent(AGENT_TOKEN)
    await waitInbox(agent.inbox)
    const req = requestSession(AGENT_ID)
    if (!('row' in req)) throw new Error('session non créée')
    const decided = decideSession(req.row.id, true)
    if (!decided.ok) throw new Error('échec approve')
    const viewer = await connectViewer(decided.viewToken!)

    endSessionByViewToken(decided.viewToken!)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(agentSessions().find((s) => s.id === req.row.id)?.status).toBe('ended')
    viewer.ws.close()
    agent.ws.close()
  })

  it('mesure la latence agent par ping/pong', async () => {
    const agent = await connectAgent(AGENT_TOKEN)
    await waitInbox(agent.inbox)
    const entry = agentEntryByToken(AGENT_TOKEN)
    expect(entry).toBeDefined()
    entry!.ws.ping(String(Date.now()))
    const t0 = Date.now()
    while (Date.now() - t0 < 1500 && (entry!.latency ?? null) === null) {
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect(entry!.latency).toBeTypeOf('number')
    expect(entry!.latency!).toBeGreaterThanOrEqual(0)
    const status = agentStatuses()[0]!
    expect(status.latency).toBeTypeOf('number')
    agent.ws.close()
  })

  it('vire les sessions en attente trop anciennes (TTL pending)', async () => {
    const repo = getRepository()
    const id = repo.createRemoteSession({ agentToken: AGENT_TOKEN, agentLabel: 'Boite', remoteIp: '127.0.0.1' })
    expect(repo.getRemoteSession(id)?.status).toBe('pending')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 40_000)
    sweepStaleSessions()
    expect(repo.getRemoteSession(id)?.status).toBe('ended')
    vi.useRealTimers()
  })

  it('relaie streamConfig viewer→agent et ignore les valeurs invalides', async () => {
    const agent = await connectAgent(AGENT_TOKEN)
    await waitInbox(agent.inbox)
    const req = requestSession(AGENT_ID)
    if (!('row' in req)) throw new Error('session non créée')
    const decided = decideSession(req.row.id, true)
    if (!decided.ok) throw new Error('échec approve')
    await waitInbox(agent.inbox) // startStream
    agent.ws.send(JSON.stringify({ type: 'dims', width: 1920, height: 1080 }))
    const viewer = await connectViewer(decided.viewToken!)
    await waitInbox(viewer.inbox) // start

    viewer.ws.send(JSON.stringify({ type: 'streamConfig', maxFps: 6, quality: 80 }))
    const relayed = (await waitInbox(agent.inbox)) as { type: string; maxFps: number; quality: number }
    expect(relayed).toMatchObject({ type: 'streamConfig', maxFps: 6, quality: 80 })

    viewer.ws.send(JSON.stringify({ type: 'streamConfig', maxFps: 99, quality: 10 }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    const leftover = (await waitInbox(agent.inbox, 250).catch(() => 'timeout')) as unknown
    expect(leftover).toBe('timeout')

    viewer.ws.close()
    agent.ws.close()
  })
})