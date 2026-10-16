import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { localMachine, parseAddress, resolveMachine } from './addresses.ts'
import { BoiteError, normalizeText } from './errors.ts'
import { gate, isWorking, type AgentState, type GateResult } from './gate.ts'

export interface AgentRow {
  thread_id: string
  machine: string
  name: string
  state: AgentState
  projects: string[]
  projects_suspended: number
  last_activity: 'complete' | 'edit' | null
  completed_at: number | null
  created_at: number
  updated_at: number
}

export interface MessageRow {
  id: number
  thread_id: string
  direction: 'in' | 'out'
  body: string
  refs: string[]
  status: 'held' | 'delivered' | 'read'
  reply_to: number | null
  created_at: number
}

interface RawAgent {
  thread_id: string
  machine: string
  name: string
  name_norm: string
  state: AgentState
  projects: string
  projects_suspended: number
  last_activity: 'complete' | 'edit' | null
  completed_at: number | null
  created_at: number
  updated_at: number
}

interface RawMessage {
  id: number
  thread_id: string
  direction: 'in' | 'out'
  body: string
  body_norm: string
  refs: string
  status: 'held' | 'delivered' | 'read'
  reply_to: number | null
  created_at: number
}

function toJsonArray(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function toAgent(raw: RawAgent): AgentRow {
  return {
    thread_id: raw.thread_id,
    machine: raw.machine,
    name: raw.name,
    state: raw.state,
    projects: toJsonArray(raw.projects),
    projects_suspended: raw.projects_suspended,
    last_activity: raw.last_activity,
    completed_at: raw.completed_at,
    created_at: raw.created_at,
    updated_at: raw.updated_at
  }
}

function toMessage(raw: RawMessage): MessageRow {
  return {
    id: raw.id,
    thread_id: raw.thread_id,
    direction: raw.direction,
    body: raw.body,
    refs: toJsonArray(raw.refs),
    status: raw.status,
    reply_to: raw.reply_to,
    created_at: raw.created_at
  }
}

function slugify(name: string): string {
  const base = normalizeText(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base.length > 0 ? base : 'agent'
}

export interface CreateAgentInput {
  name: string
  threadId?: string
  projects?: readonly string[]
}

export function createAgent(db: DatabaseSync, input: CreateAgentInput): AgentRow {
  const name = input.name.trim()
  if (name.length === 0) throw new BoiteError('USAGE', "nom d'agent vide")
  const machine = localMachine()
  const threadId = input.threadId ?? `${slugify(name)}-${randomBytes(3).toString('hex')}`
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(threadId)) {
    throw new BoiteError('USAGE', `identifiant invalide '${threadId}' : [a-z0-9._-], 64 max`)
  }
  const now = Date.now()
  const projects = JSON.stringify([...new Set(input.projects ?? [])])
  try {
    db.prepare(
      `INSERT INTO agents (thread_id, machine, name, name_norm, state, projects, projects_suspended,
                           last_activity, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'idle', ?, 0, NULL, NULL, ?, ?)`
    ).run(threadId, machine, name, normalizeText(name), projects, now, now)
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      throw new BoiteError('USAGE', `identifiant déjà utilisé : '${threadId}'`)
    }
    throw error
  }
  return requireAgent(db, `${machine}/${threadId}`)
}

export function getAgent(db: DatabaseSync, address: string): AgentRow | null {
  const parsed = parseAddress(address)
  const machine = resolveMachine(parsed.machine)
  const raw = db
    .prepare('SELECT * FROM agents WHERE thread_id = ? AND machine = ?')
    .get(parsed.threadId, machine) as unknown as RawAgent | undefined
  return raw ? toAgent(raw) : null
}

function requireAgent(db: DatabaseSync, address: string): AgentRow {
  const agent = getAgent(db, address)
  if (!agent) throw new BoiteError('NOT_FOUND', `agent inconnu : '${address}'`)
  return agent
}

export function listAgents(db: DatabaseSync, options: { all?: boolean } = {}): AgentRow[] {
  const sql = options.all
    ? 'SELECT * FROM agents ORDER BY updated_at DESC'
    : "SELECT * FROM agents WHERE state != 'archived' ORDER BY updated_at DESC"
  return (db.prepare(sql).all() as unknown as RawAgent[]).map(toAgent)
}

export interface DeliveryOutcome {
  message: MessageRow
  warnings: string[]
  held: boolean
}

export interface DeliveryPayload {
  body: string
  refs?: readonly string[]
  projects?: readonly string[]
  ready?: boolean
  now?: number
  kind?: 'send' | 'reply'
  replyTo?: number
}

export interface SendInput extends DeliveryPayload {
  address: string
}

function applyDelivery(db: DatabaseSync, agent: AgentRow, now: number): void {
  const next: AgentState =
    agent.state === 'idle' || agent.state === 'waiting' ? 'queued' : agent.state
  db.prepare(
    `UPDATE agents SET state = ?, projects_suspended = 0, updated_at = ? WHERE thread_id = ?`
  ).run(next, now, agent.thread_id)
}

function applyProjects(db: DatabaseSync, agent: AgentRow, projects: readonly string[]): void {
  if (projects.length === 0) return
  const merged = [...new Set([...agent.projects, ...projects])]
  db.prepare('UPDATE agents SET projects = ? WHERE thread_id = ?').run(
    JSON.stringify(merged),
    agent.thread_id
  )
}

function deliver(
  db: DatabaseSync,
  agent: AgentRow,
  input: DeliveryPayload,
  direction: 'in' | 'out'
): DeliveryOutcome {
  const refs = input.refs ?? []
  const now = input.now ?? Date.now()
  const result: GateResult = gate(
    { state: agent.state, lastActivity: agent.last_activity, completedAt: agent.completed_at },
    { kind: input.kind ?? 'send', ready: input.ready ?? false, body: input.body, refs, now }
  )
  if (result.verdict === 'refuse') {
    throw new BoiteError(result.code, result.message)
  }

  const held = result.verdict === 'hold'
  if (input.projects) applyProjects(db, agent, input.projects)
  const info = db
    .prepare(
      `INSERT INTO messages (thread_id, direction, body, body_norm, refs, status, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      agent.thread_id,
      direction,
      input.body,
      normalizeText(input.body),
      JSON.stringify(refs),
      held ? 'held' : 'delivered',
      input.replyTo ?? null,
      now
    )

  if (!held) {
    applyDelivery(db, agent, now)
  } else {
    db.prepare('UPDATE agents SET updated_at = ? WHERE thread_id = ?').run(now, agent.thread_id)
  }

  const message = db
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as unknown as RawMessage
  return { message: toMessage(message), warnings: result.warnings, held }
}

export function sendMessage(db: DatabaseSync, input: SendInput): DeliveryOutcome {
  const agent = requireAgent(db, input.address)
  return deliver(db, agent, { ...input, kind: input.kind ?? 'send' }, 'out')
}

export function replyMessage(
  db: DatabaseSync,
  input: Omit<SendInput, 'address'> & { messageId: number }
): DeliveryOutcome {
  const { messageId, ...payload } = input
  const raw = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as unknown as
    | RawMessage
    | undefined
  if (!raw) throw new BoiteError('NOT_FOUND', `message #${messageId} introuvable`)
  const agent = requireAgent(db, raw.thread_id)
  // Une réponse prend le sens inverse du message auquel elle répond :
  // réponse à un message de l'agent => message entrant, et inversement.
  const direction = raw.direction === 'out' ? 'in' : 'out'
  return deliver(db, agent, { ...payload, kind: 'reply', replyTo: messageId }, direction)
}

export function readThread(db: DatabaseSync, address: string): MessageRow[] {
  const agent = requireAgent(db, address)
  const rows = db
    .prepare("SELECT * FROM messages WHERE thread_id = ? AND direction = 'in' AND status = 'delivered'")
    .all(agent.thread_id) as unknown as RawMessage[]
  if (rows.length > 0) {
    db.prepare("UPDATE messages SET status = 'read' WHERE thread_id = ? AND direction = 'in' AND status = 'delivered'").run(
      agent.thread_id
    )
  }
  return allMessages(db, agent.thread_id)
}

export function allMessages(db: DatabaseSync, threadId: string): MessageRow[] {
  return (
    db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id').all(threadId) as unknown as RawMessage[]
  ).map(toMessage)
}

export function logThread(db: DatabaseSync, address: string, limit = 20): MessageRow[] {
  const agent = requireAgent(db, address)
  const rows = db
    .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?')
    .all(agent.thread_id, limit) as unknown as RawMessage[]
  return rows.reverse().map(toMessage)
}

export interface FindResult {
  agent: AgentRow
  snippet: string | null
}

export function findAgents(db: DatabaseSync, words: readonly string[]): FindResult[] {
  const terms = words.map((w) => normalizeText(w)).filter((w) => w.length > 0)
  if (terms.length === 0) throw new BoiteError('USAGE', 'aucun mot de recherche')
  const conditions: string[] = []
  const params: string[] = []
  for (const term of terms) {
    const like = `%${term}%`
    conditions.push(
      `(a.name_norm LIKE ? OR a.thread_id LIKE ? OR EXISTS (
         SELECT 1 FROM messages m WHERE m.thread_id = a.thread_id AND m.body_norm LIKE ?))`
    )
    params.push(like, like, like)
  }
  const snippetWord = `%${terms[0]}%`
  const sql = `
    SELECT a.*,
           (SELECT m.body FROM messages m
             WHERE m.thread_id = a.thread_id AND m.body_norm LIKE ?
             ORDER BY m.id DESC LIMIT 1) AS snippet
      FROM agents a
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.updated_at DESC`
  const rows = db.prepare(sql).all(snippetWord, ...params) as unknown as (RawAgent & { snippet: string | null })[]
  return rows.map((row) => ({ agent: toAgent(row), snippet: row.snippet }))
}

export function setState(
  db: DatabaseSync,
  address: string,
  from: readonly AgentState[] | null,
  patch: (agent: AgentRow, now: number) => Record<string, unknown>
): AgentRow {
  const agent = requireAgent(db, address)
  const now = Date.now()
  if (from && !from.includes(agent.state)) {
    throw new BoiteError(
      'INVALID_STATE',
      `état ${agent.state} : action refusée (attendu : ${from.join(' ou ')})`
    )
  }
  const values = patch(agent, now)
  const keys = Object.keys(values)
  const assignments = keys.map((k) => `${k} = ?`).join(', ')
  db.prepare(`UPDATE agents SET ${assignments}, updated_at = ? WHERE thread_id = ?`).run(
    ...keys.map((k) => values[k] as string | number | null),
    now,
    agent.thread_id
  )
  return requireAgent(db, address)
}

function deliverHeld(db: DatabaseSync, agent: AgentRow, now: number): boolean {
  const held = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND status = 'held'")
    .get(agent.thread_id) as { n: number }
  if (held.n === 0) return false
  db.prepare("UPDATE messages SET status = 'delivered' WHERE thread_id = ? AND status = 'held'").run(
    agent.thread_id
  )
  db.prepare('UPDATE agents SET projects_suspended = 0, updated_at = ? WHERE thread_id = ?').run(
    now,
    agent.thread_id
  )
  return true
}

// Une pause retient les messages ; la reprise les livre — et une livraison
// réactive les projets suspendus de l'agent.
export function pauseAgent(db: DatabaseSync, address: string): AgentRow {
  return setState(db, address, ['idle', 'queued', 'running', 'waiting'], () => ({
    state: 'paused',
    projects_suspended: 1
  }))
}

export function resumeAgent(db: DatabaseSync, address: string): AgentRow {
  const updated = setState(db, address, ['paused'], (agent, now) => {
    const delivered = deliverHeld(db, agent, now)
    return { state: delivered ? 'queued' : 'idle', projects_suspended: 0 }
  })
  return updated
}

export function archiveAgent(db: DatabaseSync, address: string): AgentRow {
  return setState(db, address, ['idle', 'queued', 'running', 'waiting', 'paused'], () => ({
    state: 'archived',
    projects_suspended: 1
  }))
}

export function restoreAgent(db: DatabaseSync, address: string): AgentRow {
  return setState(db, address, ['archived'], (agent, now) => {
    const delivered = deliverHeld(db, agent, now)
    return { state: delivered ? 'queued' : 'idle', projects_suspended: 0 }
  })
}

export function runAgent(db: DatabaseSync, address: string): AgentRow {
  return setState(db, address, ['queued'], () => ({ state: 'running' }))
}

export function doneAgent(db: DatabaseSync, address: string, options: { waiting?: boolean } = {}): AgentRow {
  const now = Date.now()
  return setState(db, address, ['running'], () => ({
    state: options.waiting ? 'waiting' : 'idle',
    last_activity: 'complete',
    completed_at: now
  }))
}

export function editAgent(db: DatabaseSync, address: string): AgentRow {
  // Une édition n'est pas une complétion : completed_at reste intact, c'est ce
  // qui fait que la grâce de 15 minutes n'est jamais entretenue par un edit.
  return setState(db, address, null, () => ({ last_activity: 'edit' }))
}

export interface WaitOutcome {
  state: AgentState
  reason: 'state' | 'reply' | 'idle'
}

const POLL_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForState(
  db: DatabaseSync,
  address: string,
  options: { timeoutMs?: number } = {}
): Promise<WaitOutcome> {
  const agent = requireAgent(db, address)
  const deadline = Date.now() + (options.timeoutMs ?? 0)
  let current = agent.state
  while (isWorking(current)) {
    if (options.timeoutMs !== undefined && Date.now() >= deadline) {
      throw new BoiteError('TIMEOUT', `délai dépassé : '${address}' reste ${current}`)
    }
    await sleep(POLL_MS)
    current = requireAgent(db, address).state
  }
  return { state: current, reason: 'state' }
}

export async function waitForReply(
  db: DatabaseSync,
  address: string,
  options: { afterId: number; timeoutMs?: number }
): Promise<WaitOutcome> {
  const agent = requireAgent(db, address)
  const deadline = Date.now() + (options.timeoutMs ?? 0)
  for (;;) {
    const reply = db
      .prepare(
        "SELECT id FROM messages WHERE thread_id = ? AND direction = 'in' AND id > ? ORDER BY id LIMIT 1"
      )
      .get(agent.thread_id, options.afterId) as { id: number } | undefined
    if (reply) return { state: requireAgent(db, address).state, reason: 'reply' }
    const state = requireAgent(db, address).state
    if (state === 'idle') return { state, reason: 'idle' }
    if (options.timeoutMs !== undefined && Date.now() >= deadline) {
      throw new BoiteError('TIMEOUT', `délai dépassé : aucune réponse de '${address}'`)
    }
    await sleep(POLL_MS)
  }
}
