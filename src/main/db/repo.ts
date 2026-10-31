import type { Db } from './db'

export interface ProgramInput {
  id: string
  handle: string
  name: string
  type: string | null
  status: string | null
  confidentiality: string | null
  minBounty: { value: number; currency: string } | null
  maxBounty: { value: number; currency: string } | null
  industry: string | null
  webLink: string | null
  following: boolean
  rawJson: string | null
}

export interface ProgramSummary extends Omit<ProgramInput, 'rawJson'> {
  /**
   * Blob de l'API. Absent des listes : il pese plusieurs dizaines de Ko par
   * programme et aucun ecran de liste ne l'utilise. Seul `getProgram`
   * (detail) le hydrate.
   */
  rawJson?: string | null
  favorite: boolean
  note: string
  tags: string[]
  groups: string[]
  updatedAt: number
}

export interface CredentialRow {
  id: number
  program_id: string
  label: string
  username: string
  secret_enc: string
  note: string
  created_at: number
  updated_at: number
}

export interface ScanRow {
  id: number
  program_id: string
  depth: string
  status: string
  rate_limit: number
  roe_confirm: number
  started_at: number
  finished_at: number | null
}

/** ScanRow enrichi par la jointure programmes (tableau de bord global). */
export interface ScanOverviewRow extends ScanRow {
  program_name: string | null
  program_handle: string | null
}

export interface ScanEventRow {
  id: number
  scan_id: number
  seq: number
  ts: number
  level: string
  message: string
}

export interface McpRequestRow {
  id: number
  ts: number
  token_label: string
  tool: string
  args_json: string
  status: string
  ms: number
  remote_ip: string
}

export interface McpMachineRow {
  tokenLabel: string
  lastSeen: number
  calls: number
  errors: number
  ip: string | null
}

export interface RemoteSessionRow {
  id: number
  agent_token: string
  agent_label: string
  remote_ip: string
  status: string
  width: number | null
  height: number | null
  requested_at: number
  decided_at: number | null
  ended_at: number | null
}

export interface FindingRow {
  id: number
  program_id: string
  program_name: string
  asset: string
  title: string
  severity: string
  cvss: number | null
  status: string
  description: string
  poc: string
  report_path: string | null
  scan_id: number | null
  created_at: number
  updated_at: number
}

export interface FindingInput {
  programId: string
  asset: string
  title: string
  severity: string
  cvss: number | null
  status?: string
  description: string
  poc: string
  scanId: number | null
  reportPath: string | null
}

export interface FindingFilter {
  programId?: string
  status?: string
  severity?: string
  search?: string
  limit?: number
  offset?: number
}

export interface ProgramQuery {
  search?: string
  favoriteOnly?: boolean
  groupId?: number
  tagId?: number
  sort?: 'name' | 'bounty' | 'recent'
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface GroupInfo {
  id: number
  name: string
  color: string | null
  memberCount: number
}

export interface TagInfo {
  id: number
  name: string
  count: number
}

/**
 * Colonnes communes. `raw_json` n'est volontairement pas dans cette liste :
 * c'est le blob complet de l'API, parfois plusieurs dizaines de Ko par
 * programme, et les listes n'en ont pas besoin. Seul le detail le charge.
 */
const PROGRAM_COLUMNS = `
  p.id, p.handle, p.name, p.type, p.status, p.confidentiality,
  p.min_bounty_value, p.min_bounty_currency,
  p.max_bounty_value, p.max_bounty_currency,
  p.industry, p.web_link, p.following, p.updated_at,
  COALESCE(f.favorite, 0) AS favorite, COALESCE(f.note, '') AS note
`

const PROGRAM_DETAIL_COLUMNS = `
  p.id, p.handle, p.name, p.type, p.status, p.confidentiality,
  p.min_bounty_value, p.min_bounty_currency,
  p.max_bounty_value, p.max_bounty_currency,
  p.industry, p.web_link, p.following, p.raw_json, p.updated_at,
  COALESCE(f.favorite, 0) AS favorite, COALESCE(f.note, '') AS note
`

/**
 * Echappe les jokers LIKE pour qu'une recherche de "100%" ou "a_b"
 * cherche litteralement, au lieu de se comporter en joker.
 */
function likeContains(raw: string): string {
  const escaped = raw.replace(/[\\%_]/g, (c) => `\\${c}`)
  return `%${escaped}%`
}

interface ProgramRow {
  id: string
  handle: string
  name: string
  type: string | null
  status: string | null
  confidentiality: string | null
  min_bounty_value: number | null
  min_bounty_currency: string | null
  max_bounty_value: number | null
  max_bounty_currency: string | null
  industry: string | null
  web_link: string | null
  following: number
  raw_json: string | null
  updated_at: number
  favorite: number
  note: string
}

export class Repository {
  private readonly upsertProgramStmt: ReturnType<Db['prepare']>
  /** Horodatage de la derniere purge du journal MCP (purge amortie, cf. appendMcpRequest). */
  private lastMcpPruneAt = 0

  constructor(private readonly db: Db) {
    this.upsertProgramStmt = db.prepare(`
    INSERT INTO programs (
      id, handle, name, type, status, confidentiality,
      min_bounty_value, min_bounty_currency, max_bounty_value, max_bounty_currency,
      industry, web_link, following, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      handle = excluded.handle, name = excluded.name, type = excluded.type,
      status = excluded.status, confidentiality = excluded.confidentiality,
      min_bounty_value = excluded.min_bounty_value,
      min_bounty_currency = excluded.min_bounty_currency,
      max_bounty_value = excluded.max_bounty_value,
      max_bounty_currency = excluded.max_bounty_currency,
      industry = excluded.industry, web_link = excluded.web_link,
      following = excluded.following, raw_json = excluded.raw_json,
      updated_at = MAX(updated_at, excluded.updated_at)
  `)
  }

  upsertProgram(p: ProgramInput): void {
    this.upsertProgramStmt.run(
      p.id,
      p.handle,
      p.name,
      p.type,
      p.status,
      p.confidentiality,
      p.minBounty?.value ?? null,
      p.minBounty?.currency ?? null,
      p.maxBounty?.value ?? null,
      p.maxBounty?.currency ?? null,
      p.industry,
      p.webLink,
      p.following ? 1 : 0,
      p.rawJson ?? null,
      Date.now(),
    )
  }

  upsertPrograms(rows: ProgramInput[]): void {
    this.db.exec('BEGIN;')
    try {
      for (const r of rows) this.upsertProgram(r)
      this.db.exec('COMMIT;')
    } catch (err) {
      this.db.exec('ROLLBACK;')
      throw err
    }
  }

  countPrograms(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM programs').get() as unknown as {
      n: number
    }
    return row.n
  }

  private loadProgram(id: string): ProgramRow | undefined {
    return this.db
      .prepare(`SELECT ${PROGRAM_DETAIL_COLUMNS} FROM programs p LEFT JOIN favorites f ON f.program_id = p.id WHERE p.id = ?`)
      .get(id) as unknown as ProgramRow | undefined
  }

  /**
   * `ids` limite la requete aux programmes affiches. Sans argument on charge
   * tout (detail unitaire) ; avec la liste des ids de la page courante on
   * evite de ramener les Tags de thousands de programmes jamais affiches.
   */
  private tagsByProgram(ids?: string[]): Map<string, string[]> {
    const rows = (ids
      ? this.db
          .prepare(
            `SELECT pt.program_id AS pid, t.name FROM program_tags pt JOIN tags t ON t.id = pt.tag_id
             WHERE pt.program_id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids)
      : this.db
          .prepare('SELECT pt.program_id AS pid, t.name FROM program_tags pt JOIN tags t ON t.id = pt.tag_id')
          .all()) as Array<{ pid: string; name: string }>
    const map = new Map<string, string[]>()
    for (const r of rows) {
      const list = map.get(r.pid)
      if (list) list.push(r.name)
      else map.set(r.pid, [r.name])
    }
    return map
  }

  private groupsByProgram(ids?: string[]): Map<string, string[]> {
    const rows = (ids
      ? this.db
          .prepare(
            `SELECT gm.program_id AS pid, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id
             WHERE gm.program_id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids)
      : this.db
          .prepare('SELECT gm.program_id AS pid, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id')
          .all()) as Array<{ pid: string; name: string }>
    const map = new Map<string, string[]>()
    for (const r of rows) {
      const list = map.get(r.pid)
      if (list) list.push(r.name)
      else map.set(r.pid, [r.name])
    }
    return map
  }

  private toSummary(row: ProgramRow, tags: string[], groups: string[]): ProgramSummary {
    return {
      id: row.id,
      handle: row.handle,
      name: row.name,
      type: row.type,
      status: row.status,
      confidentiality: row.confidentiality,
      minBounty:
        row.min_bounty_value !== null && row.min_bounty_value !== undefined
          ? { value: row.min_bounty_value, currency: row.min_bounty_currency ?? '' }
          : null,
      maxBounty:
        row.max_bounty_value !== null && row.max_bounty_value !== undefined
          ? { value: row.max_bounty_value, currency: row.max_bounty_currency ?? '' }
          : null,
      industry: row.industry,
      webLink: row.web_link ?? null,
      following: row.following === 1,
      rawJson: row.raw_json ?? null,
      favorite: row.favorite === 1,
      note: row.note,
      tags,
      groups,
      updatedAt: row.updated_at,
    }
  }

  private whereAndParams(q: ProgramQuery): { where: string; params: Array<string | number> } {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (q.favoriteOnly) clauses.push('f.favorite = 1')
    if (q.groupId !== undefined) {
      clauses.push('EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = ? AND gm.program_id = p.id)')
      params.push(q.groupId)
    }
    if (q.tagId !== undefined) {
      clauses.push('EXISTS (SELECT 1 FROM program_tags pt WHERE pt.tag_id = ? AND pt.program_id = p.id)')
      params.push(q.tagId)
    }
    if (q.search && q.search.trim() !== '') {
      clauses.push(
        "(p.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR p.handle LIKE ? ESCAPE '\\' COLLATE NOCASE OR p.industry LIKE ? ESCAPE '\\' COLLATE NOCASE)",
      )
      const like = likeContains(q.search.trim())
      params.push(like, like, like)
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params }
  }

  private orderBy(q: ProgramQuery): string {
    const sort = q.sort ?? 'name'
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC'
    switch (sort) {
      case 'bounty':
        // Même raison que « recent » : sans dernier critère, deux programmes
        // portant la même prime ET le même nom (courant avec des primes
        // absentes, toutes groupées) ne sont pas dans un ordre total, et la
        // pagination OFFSET saute ou répète des lignes. Les primes absentes
        // restent en fin de liste dans les deux sens.
        return `ORDER BY CASE WHEN p.max_bounty_value IS NULL THEN 1 ELSE 0 END, p.max_bounty_value ${dir}, p.name COLLATE NOCASE ASC, p.id ASC`
      case 'recent':
        // L'ordre doit être total : sans second critère, deux programmes mis à
        // jour à la même milliseconde (une synchro en écrit des centaines en une
        // même ms) changent de rang d'une page à l'autre, et la pagination
        // saute ou répète des lignes. Le second critère suit aussi le sens pour
        // qu'inverser le tri inverse réellement la liste.
        return `ORDER BY p.updated_at ${dir}, p.id ${dir}`
      default:
        return `ORDER BY p.name COLLATE NOCASE ${dir}, p.id ASC`
    }
  }

  listPrograms(q: ProgramQuery = {}): { records: ProgramSummary[]; total: number } {
    const { where, params } = this.whereAndParams(q)
    const order = this.orderBy(q)
    const limit = q.limit ?? 200
    const offset = q.offset ?? 0

    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM programs p LEFT JOIN favorites f ON f.program_id = p.id ${where}`)
      .get(...params) as unknown as { n: number }
    const total = countRow.n

    const rows = this.db
      .prepare(
        `SELECT ${PROGRAM_COLUMNS} FROM programs p LEFT JOIN favorites f ON f.program_id = p.id ${where} ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as ProgramRow[]

    const ids = rows.map((r) => r.id)
    const tags = this.tagsByProgram(ids)
    const groups = this.groupsByProgram(ids)
    return {
      records: rows.map((r) =>
        this.toSummary(r, tags.get(r.id) ?? [], groups.get(r.id) ?? []),
      ),
      total,
    }
  }

  getProgram(id: string): ProgramSummary | null {
    const row = this.loadProgram(id)
    if (!row) return null
    // Borné au programme demandé : sans cela, ouvrir le detail d'un
    // programme chargeait les Tags et groupes de TOUT le catalogue.
    const tags = this.tagsByProgram([id])
    const groups = this.groupsByProgram([id])
    return this.toSummary(row, tags.get(id) ?? [], groups.get(id) ?? [])
  }

  setFavorite(programId: string, favorite: boolean): void {
    this.db
      .prepare(
        `INSERT INTO favorites (program_id, favorite, note, updated_at)
         VALUES (?, ?, '', ?)
         ON CONFLICT(program_id) DO UPDATE SET favorite = excluded.favorite, updated_at = excluded.updated_at`,
      )
      .run(programId, favorite ? 1 : 0, Date.now())
  }

  setNote(programId: string, note: string): void {
    this.db
      .prepare(
        `INSERT INTO favorites (program_id, favorite, note, updated_at)
         VALUES (?, 0, ?, ?)
         ON CONFLICT(program_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(programId, note, Date.now())
  }

  createGroup(name: string, color: string | null = null): { id: number } {
    const info = this.db
      .prepare('INSERT INTO groups (name, color, created_at) VALUES (?, ?, ?)')
      .run(name, color, Date.now())
    return { id: Number(info.lastInsertRowid) }
  }

  renameGroup(id: number, name: string): void {
    const info = this.db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id)
    if (Number(info.changes) === 0) throw new Error(`Groupe introuvable (id=${id})`)
  }

  removeGroup(id: number): void {
    const info = this.db.prepare('DELETE FROM groups WHERE id = ?').run(id)
    if (Number(info.changes) === 0) throw new Error(`Groupe introuvable (id=${id})`)
  }

  listGroups(): GroupInfo[] {
    return this.db
      .prepare(
        `SELECT g.id, g.name, g.color, COUNT(gm.program_id) AS memberCount
         FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.id
         GROUP BY g.id ORDER BY g.name COLLATE NOCASE ASC`,
      )
      .all() as unknown as GroupInfo[]
  }

  addToGroup(groupId: number, programId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO group_members (group_id, program_id) VALUES (?, ?)')
      .run(groupId, programId)
  }

  removeFromGroup(groupId: number, programId: string): void {
    this.db
      .prepare('DELETE FROM group_members WHERE group_id = ? AND program_id = ?')
      .run(groupId, programId)
  }

  createTag(name: string): { id: number } {
    const info = this.db
      .prepare('INSERT INTO tags (name, created_at) VALUES (?, ?)')
      .run(name, Date.now())
    return { id: Number(info.lastInsertRowid) }
  }

  removeTag(id: number): void {
    const info = this.db.prepare('DELETE FROM tags WHERE id = ?').run(id)
    if (Number(info.changes) === 0) throw new Error(`Tag introuvable (id=${id})`)
  }

  listTags(): TagInfo[] {
    return this.db
      .prepare(
        `SELECT t.id, t.name, COUNT(pt.program_id) AS count
         FROM tags t LEFT JOIN program_tags pt ON pt.tag_id = t.id
         GROUP BY t.id ORDER BY t.name COLLATE NOCASE ASC`,
      )
      .all() as unknown as TagInfo[]
  }

  addTagToProgram(programId: string, tagId: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO program_tags (program_id, tag_id) VALUES (?, ?)')
      .run(programId, tagId)
  }

  removeTagFromProgram(programId: string, tagId: number): void {
    this.db
      .prepare('DELETE FROM program_tags WHERE program_id = ? AND tag_id = ?')
      .run(programId, tagId)
  }

  setProgramDetail(programId: string, scopeJson: string | null, roeJson: string | null, fetchedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO program_details (program_id, scope_json, roe_json, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(program_id) DO UPDATE SET scope_json = excluded.scope_json, roe_json = excluded.roe_json, fetched_at = excluded.fetched_at`,
      )
      .run(programId, scopeJson, roeJson, fetchedAt)
  }

  getProgramDetail(programId: string): { scopeJson: string | null; roeJson: string | null; fetchedAt: number } | null {
    return this.db
      .prepare(
        'SELECT scope_json AS scopeJson, roe_json AS roeJson, fetched_at AS fetchedAt FROM program_details WHERE program_id = ?',
      )
      .get(programId) as unknown as { scopeJson: string | null; roeJson: string | null; fetchedAt: number } | null
  }

  /**
   * Empreinte du scope au dernier rafraichissement. Un JSON corrompu est traite
   * comme une absence d'empreinte : on prefere ne rien signaler plutot que
   * d'afficher un diff fantaisiste.
   */
  getScopeState(programId: string): { entries: string[]; checkedAt: number } | null {
    const row = this.db
      .prepare('SELECT entries_json AS entriesJson, checked_at AS checkedAt FROM program_scope_state WHERE program_id = ?')
      .get(programId) as unknown as { entriesJson: string; checkedAt: number } | undefined
    if (!row) return null
    try {
      const parsed: unknown = JSON.parse(row.entriesJson)
      if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === 'string')) return null
      return { entries: parsed, checkedAt: row.checkedAt }
    } catch {
      return null
    }
  }

  saveScopeState(programId: string, entries: string[], checkedAt: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO program_scope_state (program_id, entries_json, checked_at)
         VALUES (?, ?, ?)
         ON CONFLICT(program_id) DO UPDATE SET
           entries_json = excluded.entries_json, checked_at = excluded.checked_at`,
      )
      .run(programId, JSON.stringify(entries), checkedAt)
  }

  listCredentials(programId: string): CredentialRow[] {
    return this.db
      .prepare(
        'SELECT id, program_id, label, username, secret_enc, note, created_at, updated_at FROM credentials WHERE program_id = ? ORDER BY label COLLATE NOCASE ASC',
      )
      .all(programId) as unknown as CredentialRow[]
  }

  getCredential(id: number): CredentialRow | undefined {
    return this.db
      .prepare(
        'SELECT id, program_id, label, username, secret_enc, note, created_at, updated_at FROM credentials WHERE id = ?',
      )
      .get(id) as unknown as CredentialRow | undefined
  }

  createCredential(input: { programId: string; label: string; username: string; secretEnc: string; note: string }): number {
    const info = this.db
      .prepare(
        'INSERT INTO credentials (program_id, label, username, secret_enc, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(input.programId, input.label, input.username, input.secretEnc, input.note, Date.now(), Date.now())
    return Number(info.lastInsertRowid)
  }

  updateCredential(id: number, patch: { label?: string; username?: string; secretEnc?: string; note?: string }): void {
    const sets: string[] = []
    const vals: string[] = []
    const cols: [keyof typeof patch, string][] = [
      ['label', 'label'],
      ['username', 'username'],
      ['secretEnc', 'secret_enc'],
      ['note', 'note'],
    ]
    for (const [key, col] of cols) {
      const val = patch[key]
      if (val !== undefined) {
        sets.push(`${col} = ?`)
        vals.push(val as string)
      }
    }
    if (sets.length === 0) throw new Error('Aucun champ à mettre à jour')
    const info = this.db
      .prepare(`UPDATE credentials SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...vals, Date.now(), id)
    if (Number(info.changes) === 0) throw new Error(`Identifiant introuvable (id=${id})`)
  }

  removeCredential(id: number): void {
    const info = this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
    if (Number(info.changes) === 0) throw new Error(`Identifiant introuvable (id=${id})`)
  }

  createScan(input: { programId: string; depth: string; rateLimit: number; roeConfirm: boolean }): number {
    const info = this.db
      .prepare(
        'INSERT INTO scans (program_id, depth, status, rate_limit, roe_confirm, started_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(input.programId, input.depth, 'running', input.rateLimit, input.roeConfirm ? 1 : 0, Date.now())
    return Number(info.lastInsertRowid)
  }

  updateScan(id: number, patch: { status?: string; finishedAt?: number }): void {
    const current = this.db.prepare('SELECT * FROM scans WHERE id = ?').get(id) as unknown as ScanRow | undefined
    if (!current) throw new Error(`Scan introuvable (id=${id})`)
    const status = patch.status ?? current.status
    const finishedAt = patch.finishedAt ?? current.finished_at
    this.db.prepare('UPDATE scans SET status = ?, finished_at = ? WHERE id = ?').run(status, finishedAt, id)
  }

  /**
   * Un scan "running" ne peut pas survivre au processus qui l'a lancé : après
   * un crash ou un redémarrage, la ligne resterait bloquée sur un statut
   * définitif et l'interface pollerait pour toujours un scan qui n'existe plus.
   */
  failOrphanScans(now: number = Date.now()): number {
    const rows = this.db.prepare("SELECT id FROM scans WHERE status = 'running'").all() as unknown as {
      id: number
    }[]
    if (rows.length === 0) return 0
    const upd = this.db.prepare("UPDATE scans SET status = 'error', finished_at = ? WHERE id = ?")
    const evt = this.db.prepare(
      'INSERT INTO scan_events (scan_id, seq, ts, level, message) VALUES (?, ?, ?, ?, ?)'
    )
    const message = "Scan interrompu par l’arrêt ou le redémarrage de Venari."
    this.db.exec('BEGIN')
    try {
      for (const row of rows) {
        upd.run(now, row.id)
        evt.run(row.id, this.countScanEvents(row.id) + 1, now, 'error', message)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* transaction déjà refermée par SQLite */
      }
      throw err
    }
    return rows.length
  }

  listScans(programId: string): ScanRow[] {
    return this.db
      .prepare('SELECT * FROM scans WHERE program_id = ? ORDER BY id DESC LIMIT 100')
      .all(programId) as unknown as ScanRow[]
  }

  /**
   * Tous les scans, du plus recent au plus ancien, avec l'identite du
   * programme. Sert au tableau de bord global : sans lui, un scan lance
   * depuis une fiche n'est plus consultable une fois la fiche fermee.
   */
  listAllScans(limit = 200): ScanOverviewRow[] {
    return this.db
      .prepare(
        `SELECT s.*, p.name AS program_name, p.handle AS program_handle
         FROM scans s LEFT JOIN programs p ON p.id = s.program_id
         ORDER BY s.id DESC LIMIT ?`
      )
      .all(limit) as unknown as ScanOverviewRow[]
  }

  getScan(id: number): ScanRow | undefined {
    return this.db.prepare('SELECT * FROM scans WHERE id = ?').get(id) as unknown as ScanRow | undefined
  }

  removeScan(id: number): void {
    this.db.prepare('DELETE FROM scans WHERE id = ?').run(id)
  }

  appendScanEvent(scanId: number, seq: number, level: string, message: string, ts: number): void {
    this.db
      .prepare('INSERT INTO scan_events (scan_id, seq, ts, level, message) VALUES (?, ?, ?, ?, ?)')
      .run(scanId, seq, ts, level, message)
  }

  /**
   * Lot d'événements dans une seule transaction. Un outil bavard (ffuf, nuclei)
   * produit des centaines de lignes par seconde : un INSERT par chunk bloquait
   * l'événements du process principal et faisait vaciller toute l'interface.
   */
  appendScanEvents(
    scanId: number,
    rows: { seq: number; level: string; message: string; ts: number }[]
  ): void {
    if (rows.length === 0) return
    const stmt = this.db.prepare('INSERT INTO scan_events (scan_id, seq, ts, level, message) VALUES (?, ?, ?, ?, ?)')
    this.db.exec('BEGIN')
    try {
      for (const row of rows) stmt.run(scanId, row.seq, row.ts, row.level, row.message)
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* transaction déjà refermée par SQLite */
      }
      throw err
    }
  }

  countScanEvents(scanId: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM scan_events WHERE scan_id = ?').get(scanId) as unknown as {
      n: number
    }
    return row.n
  }

  listScanEvents(scanId: number, afterSeq: number, limit = 500): ScanEventRow[] {
    return this.db
      .prepare('SELECT * FROM scan_events WHERE scan_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(scanId, afterSeq, limit) as unknown as ScanEventRow[]
  }

  /**
   * Journal complet, sans la borne de 500 lignes utilisee par le suivi live :
   * l'export doit contenir tout ce qui a ete journalise, pas la fenetre
   * actuellement affichee.
   */
  listAllScanEvents(scanId: number): ScanEventRow[] {
    return this.db
      .prepare('SELECT * FROM scan_events WHERE scan_id = ? ORDER BY seq ASC')
      .all(scanId) as unknown as ScanEventRow[]
  }

  appendMcpRequest(input: { ts: number; tokenLabel: string; tool: string; argsJson: string; status: string; ms: number; remoteIp: string }): void {
    this.db
      .prepare('INSERT INTO mcp_requests (ts, token_label, tool, args_json, status, ms, remote_ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.ts, input.tokenLabel, input.tool, input.argsJson, input.status, input.ms, input.remoteIp || '')
    // La purge coute un DELETE avec sous-requete (scan du journal) : on l'amortit
    // a une fois par minute au lieu de l'executer a chaque appel d'outil, sinon
    // une session active devient quadratique en nombre de requetes.
    if (input.ts - this.lastMcpPruneAt >= 60_000) {
      this.lastMcpPruneAt = input.ts
      this.pruneMcpRequests(input.ts)
    }
  }

  /**
   * Le journal MCP est une aide au diagnostic, pas une archive : chaque appel
   * est une ligne, donc une session de nuit en genere des dizaines de milliers.
   * On borne a 30 jours ET a 20 000 lignes, ce qui garantit une taille finie
   * meme sur une base qui n'aurait jamais ete purgee.
   */
  private pruneMcpRequests(now: number): void {
    const cutoff = now - 30 * 24 * 3600 * 1000
    this.db.prepare('DELETE FROM mcp_requests WHERE ts < ?').run(cutoff)
    const info = this.db
      .prepare(
        `DELETE FROM mcp_requests WHERE id NOT IN (
           SELECT id FROM mcp_requests ORDER BY id DESC LIMIT 20000
         )`,
      )
      .run()
    if (Number(info.changes) > 0) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  }

  listMcpRequests(limit = 100): McpRequestRow[] {
    return this.db
      .prepare('SELECT * FROM mcp_requests ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as McpRequestRow[]
  }

  mcpMachines(limit = 50): McpMachineRow[] {
    return this.db
      .prepare(
        `SELECT
           token_label AS tokenLabel,
           MAX(ts) AS lastSeen,
           COUNT(*) AS calls,
           SUM(CASE WHEN status IN ('error', '401') THEN 1 ELSE 0 END) AS errors,
           GROUP_CONCAT(DISTINCT remote_ip) AS ip
         FROM mcp_requests
         WHERE token_label != ''
         GROUP BY token_label
         ORDER BY lastSeen DESC
         LIMIT ?`
      )
      .all(limit) as unknown as McpMachineRow[]
  }

  createRemoteSession(input: { agentToken: string; agentLabel: string; remoteIp: string }): number {
    const info = this.db
      .prepare('INSERT INTO remote_sessions (agent_token, agent_label, remote_ip, status, requested_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.agentToken, input.agentLabel, input.remoteIp, 'pending', Date.now())
    return Number(info.lastInsertRowid)
  }

  getRemoteSession(id: number): RemoteSessionRow | undefined {
    return this.db.prepare('SELECT * FROM remote_sessions WHERE id = ?').get(id) as unknown as RemoteSessionRow | undefined
  }

  updateRemoteSession(
    id: number,
    patch: { status?: string; decidedAt?: number | null; endedAt?: number | null; width?: number | null; height?: number | null }
  ): void {
    const sets: string[] = []
    const vals: Array<string | number | null> = []
    const cols: [keyof typeof patch, string][] = [
      ['status', 'status'],
      ['decidedAt', 'decided_at'],
      ['endedAt', 'ended_at'],
      ['width', 'width'],
      ['height', 'height'],
    ]
    for (const [key, col] of cols) {
      const val = patch[key]
      if (val !== undefined) {
        sets.push(`${col} = ?`)
        vals.push(val as string | number | null)
      }
    }
    if (sets.length === 0) throw new Error('Aucun champ à mettre à jour')
    this.db.prepare(`UPDATE remote_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  }

  listRemoteSessions(limit = 100): RemoteSessionRow[] {
    return this.db
      .prepare('SELECT * FROM remote_sessions ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as RemoteSessionRow[]
  }

  private static readonly FINDING_COLUMNS = `
    f.id, f.program_id, p.name AS program_name, f.asset, f.title, f.severity,
    f.cvss, f.status, f.description, f.poc, f.report_path, f.scan_id,
    f.created_at, f.updated_at
  `

  createFinding(input: FindingInput): number {
    const now = Date.now()
    const info = this.db
      .prepare(
        `INSERT INTO findings (
           program_id, asset, title, severity, cvss, status, description, poc, report_path, scan_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.programId,
        input.asset,
        input.title,
        input.severity,
        input.cvss,
        input.status ?? 'open',
        input.description,
        input.poc,
        input.reportPath,
        input.scanId,
        now,
        now,
      )
    return Number(info.lastInsertRowid)
  }

  getFinding(id: number): FindingRow | undefined {
    return this.db
      .prepare(
        `SELECT ${Repository.FINDING_COLUMNS} FROM findings f JOIN programs p ON p.id = f.program_id WHERE f.id = ?`,
      )
      .get(id) as unknown as FindingRow | undefined
  }

  /**
   * Filtres combinables, tous bornes a 500 lignes : un suivi de chasse ne
   * depasse pas quelques centaines de findings, et une limite en dur evite
   * qu'une recherche vide ramene toute la table dans le renderer.
   */
  listFindings(filter: FindingFilter = {}): FindingRow[] {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (filter.programId) {
      clauses.push('f.program_id = ?')
      params.push(filter.programId)
    }
    if (filter.status) {
      clauses.push('f.status = ?')
      params.push(filter.status)
    }
    if (filter.severity) {
      clauses.push('f.severity = ?')
      params.push(filter.severity)
    }
    if (filter.search && filter.search.trim() !== '') {
      const like = likeContains(filter.search.trim())
      clauses.push(
        "(f.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR f.asset LIKE ? ESCAPE '\\' COLLATE NOCASE OR f.description LIKE ? ESCAPE '\\' COLLATE NOCASE)",
      )
      params.push(like, like, like)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(Math.max(filter.limit ?? 500, 1), 500)
    const offset = Math.max(filter.offset ?? 0, 0)
    return this.db
      .prepare(
        `SELECT ${Repository.FINDING_COLUMNS}
         FROM findings f JOIN programs p ON p.id = f.program_id
         ${where}
         ORDER BY f.updated_at DESC, f.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as FindingRow[]
  }

  updateFinding(
    id: number,
    patch: {
      asset?: string
      title?: string
      severity?: string
      cvss?: number | null
      status?: string
      description?: string
      poc?: string
      reportPath?: string | null
    },
  ): void {
    const sets: string[] = []
    const vals: Array<string | number | null> = []
    const cols: [keyof typeof patch, string][] = [
      ['asset', 'asset'],
      ['title', 'title'],
      ['severity', 'severity'],
      ['cvss', 'cvss'],
      ['status', 'status'],
      ['description', 'description'],
      ['poc', 'poc'],
      ['reportPath', 'report_path'],
    ]
    for (const [key, col] of cols) {
      const val = patch[key]
      if (val !== undefined) {
        sets.push(`${col} = ?`)
        vals.push(val as string | number | null)
      }
    }
    if (sets.length === 0) throw new Error('Aucun champ à mettre à jour')
    const info = this.db
      .prepare(`UPDATE findings SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...vals, Date.now(), id)
    if (Number(info.changes) === 0) throw new Error(`Finding introuvable (id=${id})`)
  }

  removeFinding(id: number): void {
    const info = this.db.prepare('DELETE FROM findings WHERE id = ?').run(id)
    if (Number(info.changes) === 0) throw new Error(`Finding introuvable (id=${id})`)
  }

  /**
   * Compteurs par statut pour le bandeau du suivi. Optionnellement borne a un
   * programme, pour l'afficher aussi dans le detail.
   */
  findingStats(programId?: string): Record<string, number> {
    const rows = (programId
      ? this.db.prepare('SELECT status, COUNT(*) AS n FROM findings WHERE program_id = ? GROUP BY status').all(programId)
      : this.db.prepare('SELECT status, COUNT(*) AS n FROM findings GROUP BY status').all()) as unknown as Array<{
      status: string
      n: number
    }>
    const stats: Record<string, number> = { total: 0 }
    for (const r of rows) {
      stats[r.status] = r.n
      stats.total = (stats.total ?? 0) + r.n
    }
    return stats
  }

  /**
   * Candidat doublon : meme programme, meme cible et meme titre a la casse et
   * aux espaces pres. Utilise par record_finding pour ne pas empiler le meme
   * constat a chaque re-scan.
   */
  findDuplicateFinding(programId: string, asset: string, title: string): FindingRow | undefined {
    return this.db
      .prepare(
        `SELECT ${Repository.FINDING_COLUMNS}
         FROM findings f JOIN programs p ON p.id = f.program_id
         WHERE f.program_id = ?
           AND lower(trim(f.asset)) = lower(trim(?))
           AND lower(trim(f.title)) = lower(trim(?))
         ORDER BY f.id DESC LIMIT 1`,
      )
      .get(programId, asset, title) as unknown as FindingRow | undefined
  }
}

export function createRepository(db: Db): Repository {
  return new Repository(db)
}