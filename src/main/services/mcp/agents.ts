import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { AgentStatusInfo, RemoteSessionInfo } from '../../../shared/ipc'
import { getRepository } from '../../db'
import type { RemoteSessionRow } from '../../db/repo'

export const AGENT_MAX_FPS = 12

const SESSION_PENDING_TTL = 30_000
const SESSION_ACTIVE_NO_VIEWER_TTL = 30_000
const PING_INTERVAL = 5_000
const SWEEP_INTERVAL = 10_000

export interface AgentAuthEntry {
  id: string
  label: string
  token: string
}

interface AgentEntry {
  id: string
  label: string
  token: string
  ws: WebSocket
  hostname: string
  ip: string
  lastSeen: number
  streaming: boolean
  width: number | null
  height: number | null
  latency: number | null
  closed: boolean
}

interface ViewerLink {
  ws: WebSocket
  agentToken: string
  viewToken: string
}

let wss: WebSocketServer | null = null
let agentAuth: AgentAuthEntry[] = []
let pingTimer: ReturnType<typeof setInterval> | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null
const agents = new Map<string, AgentEntry>()
const viewersBySession = new Map<number, ViewerLink>()
const viewTokens = new Map<string, { sessionId: number; agentToken: string }>()

function normalizeIp(raw: string | undefined): string {
  if (!raw) return ''
  return raw.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1')
}

function isLoopback(raw: string | undefined): boolean {
  const ip = normalizeIp(raw)
  return ip === '127.0.0.1'
}

function rowFor(sessionId: number): RemoteSessionRow | undefined {
  try {
    return getRepository().getRemoteSession(sessionId)
  } catch {
    return undefined
  }
}

/** Jeton bearer de l'agent ayant demande cette session, cote main uniquement. */
export function sessionAgentToken(sessionId: number): string | null {
  return rowFor(sessionId)?.agent_token ?? null
}

// Le jeton bearer de l'agent reste cote main : le renderer n'en a aucun besoin
// et le lire lui donnerait un acces direct aux machines d'intrusion enrolées.
function toSessionInfo(row: RemoteSessionRow): RemoteSessionInfo {
  return {
    id: row.id,
    agentLabel: row.agent_label,
    remoteIp: row.remote_ip,
    status: row.status as RemoteSessionInfo['status'],
    width: row.width,
    height: row.height,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    endedAt: row.ended_at,
  }
}

function infoOrNull(id: number): RemoteSessionInfo | null {
  const row = rowFor(id)
  return row ? toSessionInfo(row) : null
}

function sendJSON(ws: WebSocket, obj: unknown): void {
  const data = JSON.stringify(obj)
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data)
  } else if (ws.readyState === WebSocket.CONNECTING) {
    ws.once('open', () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })
  }
}

export function configureAgents(entries: AgentAuthEntry[]): void {
  agentAuth = [...entries]
  const byToken = new Set(entries.map((a) => a.token))
  for (const [token, entry] of agents) {
    if (!byToken.has(token)) {
      sendJSON(entry.ws, { type: 'bye', reason: 'jeton révoqué' })
      entry.ws.close(4001, 'token revoked')
      entry.closed = true
      agents.delete(token)
    }
  }
}

export function agentStatuses(): AgentStatusInfo[] {
  return agentAuth.map((a) => {
    const entry = agents.get(a.token)
    const active = entry ? [...viewersBySession.values()].find((v) => v.agentToken === a.token) : undefined
    return {
      id: a.id,
      label: a.label,
      online: entry !== undefined && !entry.closed,
      hostname: entry?.hostname ?? '',
      ip: entry?.ip ?? '',
      lastSeen: entry?.lastSeen ?? null,
      streaming: active !== undefined,
      latency: entry?.latency ?? null,
      activeSession: active ? findSessionByToken(a.token) : null,
    }
  })
}

function findSessionByToken(token: string): number | null {
  for (const row of getRepository().listRemoteSessions(50)) {
    if (row.agent_token === token && row.status === 'active') return row.id
  }
  return null
}

export function agentSessions(): RemoteSessionInfo[] {
  return getRepository().listRemoteSessions(50).map(toSessionInfo)
}

export function requestSession(tokenId: string): { row: RemoteSessionInfo } | { offline: true } | { busy: true } {
  const auth = agentAuth.find((a) => a.id === tokenId)
  if (!auth) return { offline: true }
  const entry = agents.get(auth.token)
  if (!entry || entry.closed) return { offline: true }
  if ([...viewersBySession.values()].some((v) => v.agentToken === auth.token)) return { busy: true }
  const id = getRepository().createRemoteSession({
    agentToken: auth.token,
    agentLabel: auth.label,
    remoteIp: entry.ip,
  })
  return { row: toSessionInfo(rowFor(id)!) }
}

export function decideSession(
  sessionId: number,
  approve: boolean
): { ok: true; session: RemoteSessionInfo; viewToken?: string } | { ok: false; error: string } {
  const repo = getRepository()
  const row = rowFor(sessionId)
  if (!row) return { ok: false, error: 'Session inconnue.' }
  if (row.status !== 'pending') return { ok: false, error: 'Session déjà traitée.' }
  if (!approve) {
    repo.updateRemoteSession(sessionId, { status: 'refused', decidedAt: Date.now() })
    return { ok: true, session: toSessionInfo(rowFor(sessionId)!) }
  }
  const entry = agents.get(row.agent_token)
  if (!entry || entry.closed) return { ok: false, error: "L'agent n'est plus en ligne." }
  if ([...viewersBySession.values()].some((v) => v.agentToken === row.agent_token)) {
    return { ok: false, error: 'Une session est déjà active sur cette machine.' }
  }
  repo.updateRemoteSession(sessionId, { status: 'active', decidedAt: Date.now() })
  const viewToken = randomBytes(24).toString('base64url')
  viewTokens.set(viewToken, { sessionId, agentToken: row.agent_token })
  entry.streaming = true
  sendJSON(entry.ws, { type: 'startStream', maxFps: AGENT_MAX_FPS })
  return { ok: true, session: toSessionInfo(rowFor(sessionId)!), viewToken }
}

export function endActiveSession(sessionId: number): void {
  const row = rowFor(sessionId)
  const repo = getRepository()
  if (row && row.status === 'active') {
    repo.updateRemoteSession(sessionId, { status: 'ended', endedAt: Date.now() })
    const entry = agents.get(row.agent_token)
    if (entry && !entry.closed) {
      entry.streaming = false
      sendJSON(entry.ws, { type: 'stopStream' })
    }
  }
  viewersBySession.delete(sessionId)
  for (const [token, link] of viewTokens) {
    if (link.sessionId === sessionId) viewTokens.delete(token)
  }
}

export function endSessionByViewToken(viewToken: string): void {
  const link = viewTokens.get(viewToken)
  if (!link) return
  endActiveSession(link.sessionId)
}

function sessionIdForAgent(token: string): number | null {
  for (const [sessionId, v] of viewersBySession) {
    if (v.agentToken === token) return sessionId
  }
  return null
}

export function agentEntryByToken(token: string): AgentEntry | undefined {
  return agents.get(token)
}

function attachViewer(ws: WebSocket, link: { sessionId: number; agentToken: string; viewToken: string }): void {
  const prev = viewersBySession.get(link.sessionId)
  if (prev) {
    sendJSON(prev.ws, { type: 'stop', reason: 'nouvelle vue' })
    prev.ws.close(1000, 'replaced')
    viewersBySession.delete(link.sessionId)
    viewTokens.delete(prev.viewToken)
  }
  const entry = agents.get(link.agentToken)
  if (!entry || entry.closed) {
    sendJSON(ws, { type: 'stop', reason: 'agent indisponible' })
    ws.close(1011, 'agent gone')
    return
  }
  viewersBySession.set(link.sessionId, { ws, agentToken: link.agentToken, viewToken: link.viewToken })
  if (entry.width && entry.height) {
    sendJSON(ws, { type: 'start', width: entry.width, height: entry.height })
  }
  if (!entry.streaming) {
    sendJSON(entry.ws, { type: 'startStream', maxFps: AGENT_MAX_FPS })
  }
  entry.streaming = true

  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    try {
      const msg = JSON.parse(data.toString('utf-8')) as { type?: string; events?: unknown; maxFps?: unknown; quality?: unknown }
      if (msg.type === 'input' && Array.isArray(msg.events) && entry && !entry.closed) {
        sendJSON(entry.ws, { type: 'input', events: msg.events })
      } else if (msg.type === 'streamConfig' && entry && !entry.closed) {
        const maxFps = Number(msg.maxFps)
        const quality = Number(msg.quality)
        if (
          Number.isInteger(maxFps) &&
          maxFps >= 1 &&
          maxFps <= AGENT_MAX_FPS &&
          Number.isInteger(quality) &&
          quality >= 20 &&
          quality <= 95
        ) {
          sendJSON(entry.ws, { type: 'streamConfig', maxFps, quality })
        }
      }
    } catch {
      // message malformé ignoré
    }
  })
  ws.on('close', () => endActiveSession(link.sessionId))
  ws.on('error', () => {
    ws.close(1011)
    endActiveSession(link.sessionId)
  })
}

// Le jeton voyage uniquement en en-tete `Authorization: Bearer` : jamais dans
// l'URL, donc jamais dans un journal, un proxy ou l'historique. L'ancien repli
// `?token=` a ete retire (il fuyait le jeton dans les URL et logs).
function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return null
  const value = header.slice(prefix.length).trim()
  return value.length > 0 ? value : null
}

/** Comparaison a duree constante pour ne pas fuiter le jeton par le timing. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const headerToken = bearerToken(req.headers.authorization) ?? ''
  if (url.pathname === '/agent') {
    // Jeton d'agent : en-tete uniquement, jamais dans l'URL (fuite via journaux,
    // proxys, historique). Aucun repli `?token=`, meme valide.
    const auth = agentAuth.find((a) => constantTimeEqual(a.token, headerToken))
    if (!auth || headerToken === '') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss?.handleUpgrade(req, socket, head, (ws) => {
      const entry: AgentEntry = {
        id: auth.id,
        label: auth.label,
        token: auth.token,
        ws: ws as WebSocket,
        hostname: '',
        ip: normalizeIp(req.socket.remoteAddress),
        lastSeen: Date.now(),
        streaming: false,
        width: null,
        height: null,
        closed: false,
        latency: null,
      }
      agents.set(auth.token, entry)
      entry.ws.on('pong', (data) => {
        entry.latency = Date.now() - Number(data.toString())
      })
      sendJSON(entry.ws, { type: 'welcome', label: auth.label })

      entry.ws.on('message', (data, isBinary) => {
        entry.lastSeen = Date.now()
        if (isBinary) {
          const sid = sessionIdForAgent(entry.token)
          const viewer = sid !== null ? viewersBySession.get(sid) : undefined
          if (viewer && viewer.ws.readyState === WebSocket.OPEN) {
            viewer.ws.send(data as Buffer, { binary: true })
          }
          return
        }
        try {
          const msg = JSON.parse(data.toString('utf-8')) as { type?: string; [k: string]: unknown }
          if (msg.type === 'hello') {
            entry.hostname = typeof msg.hostname === 'string' ? msg.hostname.slice(0, 120) : ''
          } else if (msg.type === 'dims') {
            const w = Number(msg.width)
            const h = Number(msg.height)
            if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) {
              entry.width = w
              entry.height = h
              const sid = sessionIdForAgent(entry.token)
              const viewer = sid !== null ? viewersBySession.get(sid) : undefined
              if (viewer && viewer.ws.readyState === WebSocket.OPEN) {
                sendJSON(viewer.ws, { type: 'start', width: w, height: h })
              }
            }
          }
        } catch {
          // message malformé ignoré
        }
      })
      entry.ws.on('close', () => {
        if (agents.get(auth.token) !== entry) return
        entry.closed = true
        agents.delete(auth.token)
        const sid = sessionIdForAgent(entry.token)
        if (sid !== null) endActiveSession(sid)
      })
      entry.ws.on('error', () => entry.ws.close(1011))
    })
    return
  }
  if (url.pathname === '/agent/view') {
    // Le viewToken est jetable, usage unique et rattaché à une session courte :
    // il est conçu pour voyager en URL (lien de visualisation). Le jeton d'agent
    // permanent, lui, reste strictement en en-tête ci-dessus.
    const token = headerToken || url.searchParams.get('token') || ''
    const link = viewTokens.get(token)
    if (!link || !isLoopback(req.socket.remoteAddress)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const row = rowFor(link.sessionId)
    if (!row || row.status !== 'active') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss?.handleUpgrade(req, socket, head, (ws) => {
      attachViewer(ws as WebSocket, { sessionId: link.sessionId, agentToken: link.agentToken, viewToken: token })
    })
    return
  }
  socket.destroy()
}

export function sweepStaleSessions(): void {
  const now = Date.now()
  const repo = getRepository()
  for (const row of repo.listRemoteSessions(50)) {
    if (row.status === 'pending' && now - row.requested_at > SESSION_PENDING_TTL) {
      repo.updateRemoteSession(row.id, { status: 'ended', endedAt: now })
    } else if (row.status === 'active' && !viewersBySession.has(row.id)) {
      const ref = row.decided_at ?? row.requested_at
      if (now - ref > SESSION_ACTIVE_NO_VIEWER_TTL) endActiveSession(row.id)
    }
  }
}

export function attachAgentsToServer(server: ReturnType<typeof import('node:http').createServer>): void {
  if (wss) wss.close()
  wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', upgrade)
  if (pingTimer) clearInterval(pingTimer)
  if (sweepTimer) clearInterval(sweepTimer)
  pingTimer = setInterval(() => {
    for (const entry of agents.values()) {
      if (!entry.closed && entry.ws.readyState === WebSocket.OPEN) {
        try {
          entry.ws.ping(String(Date.now()))
        } catch {
          // connexion en cours de fermeture
        }
      }
    }
  }, PING_INTERVAL)
  sweepTimer = setInterval(sweepStaleSessions, SWEEP_INTERVAL)
}

export function closeAgents(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  for (const entry of agents.values()) {
    if (!entry.closed) {
      try {
        entry.ws.close(1001, 'shutdown')
      } catch {
        // ignore
      }
    }
  }
  for (const viewer of viewersBySession.values()) {
    try {
      viewer.ws.close(1001)
    } catch {
      // ignore
    }
  }
  agents.clear()
  viewersBySession.clear()
  viewTokens.clear()
  wss?.close()
  wss = null
}

export { sessionIdForAgent }