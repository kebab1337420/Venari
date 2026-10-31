import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../src/main/db/db'
import { migrations, type Migration } from '../src/main/db/migrations'

const LAST_VERSION = migrations[migrations.length - 1]!.version

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  return db
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT user_version AS v FROM pragma_user_version').get() as
    | { v: number }
    | undefined
  return row?.v ?? 0
}

function schemaNames(db: DatabaseSync, type: 'table' | 'index'): Set<string> {
  const rows = db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

const ALL_TABLES = [
  'programs',
  'favorites',
  'groups',
  'group_members',
  'tags',
  'program_tags',
  'program_details',
  'credentials',
  'scans',
  'scan_events',
  'mcp_requests',
  'remote_sessions',
  'findings',
  'program_scope_state',
]

describe('migrations', () => {
  it('declare des versions uniques et croissantes', () => {
    const versions = migrations.map((m) => m.version)
    expect(new Set(versions).size).toBe(versions.length)
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]!).toBeGreaterThan(versions[i - 1]!)
    }
    for (const m of migrations) expect(typeof m.up).toBe('function')
  })

  it('amene une base vide a la derniere version et cree toutes les tables', () => {
    const db = fresh()
    migrate(db)
    expect(userVersion(db)).toBe(LAST_VERSION)
    const tables = schemaNames(db, 'table')
    for (const table of ALL_TABLES) expect(tables.has(table)).toBe(true)
  })

  it('monte une base ancienne par etapes en conservant les donnees', () => {
    const db = fresh()
    migrate(
      db,
      migrations.filter((m) => m.version <= 4)
    )
    expect(userVersion(db)).toBe(4)
    // Colonne et table ajoutees par les versions suivantes encore absentes.
    expect(columns(db, 'mcp_requests').has('remote_ip')).toBe(false)
    expect(schemaNames(db, 'table').has('remote_sessions')).toBe(false)

    db.exec(
      "INSERT INTO programs (id, handle, name, following, updated_at) VALUES ('p1', 'acme', 'Acme', 0, 1)"
    )

    migrate(db)
    expect(userVersion(db)).toBe(LAST_VERSION)
    expect(columns(db, 'mcp_requests').has('remote_ip')).toBe(true)
    expect(schemaNames(db, 'table').has('remote_sessions')).toBe(true)
    const row = db.prepare("SELECT name FROM programs WHERE id = 'p1'").get() as {
      name: string
    }
    expect(row.name).toBe('Acme')
  })

  it('v5 ajoute remote_ip avec une valeur par defaut vide', () => {
    const db = fresh()
    migrate(
      db,
      migrations.filter((m) => m.version <= 4)
    )
    db.exec("INSERT INTO mcp_requests (ts, tool, status, ms) VALUES (1, 'list_programs', 'ok', 2)")
    migrate(db)
    const row = db.prepare('SELECT remote_ip AS ip FROM mcp_requests').get() as { ip: string }
    expect(row.ip).toBe('')
  })

  it('v7 cree les index de tri et de recherche insensibles a la casse', () => {
    const db = fresh()
    migrate(db)
    const indexes = schemaNames(db, 'index')
    for (const name of [
      'idx_programs_name_nocase',
      'idx_programs_handle_nocase',
      'idx_programs_updated_at',
    ]) {
      expect(indexes.has(name)).toBe(true)
    }
  })

  it('v8 cree la table findings et ses index', () => {
    const db = fresh()
    migrate(db)
    const indexes = schemaNames(db, 'index')
    for (const name of ['idx_findings_program', 'idx_findings_status', 'idx_findings_updated']) {
      expect(indexes.has(name)).toBe(true)
    }
    expect(columns(db, 'findings')).toEqual(
      new Set([
        'id',
        'program_id',
        'asset',
        'title',
        'severity',
        'cvss',
        'status',
        'description',
        'poc',
        'report_path',
        'scan_id',
        'created_at',
        'updated_at',
      ]),
    )
  })

  it('v9 cree l empreinte de scope, attachee au programme', () => {
    const db = fresh()
    migrate(db)
    expect(columns(db, 'program_scope_state')).toEqual(
      new Set(['program_id', 'entries_json', 'checked_at']),
    )
    // Supprimer le programme emporte son empreinte (ON DELETE CASCADE).
    db.exec("INSERT INTO programs (id, handle, name, following, updated_at) VALUES ('p1', 'acme', 'Acme', 0, 1)")
    db.exec("INSERT INTO program_scope_state (program_id, entries_json, checked_at) VALUES ('p1', '[]', 1)")
    db.exec("DELETE FROM programs WHERE id = 'p1'")
    const row = db.prepare('SELECT COUNT(*) AS n FROM program_scope_state').get() as { n: number }
    expect(row.n).toBe(0)
  })

  it('ne rejoue rien quand la base est deja a jour', () => {
    const db = fresh()
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    expect(userVersion(db)).toBe(LAST_VERSION)
  })

  it('ne redescend jamais une version superieure a la liste', () => {
    const db = fresh()
    db.exec('PRAGMA user_version = 99;')
    migrate(db)
    expect(userVersion(db)).toBe(99)
  })

  it('annule la transaction et propage quand une migration echoue', () => {
    const db = fresh()
    const list: Migration[] = [
      { version: 1, up: (d) => d.exec('CREATE TABLE ok_a (id INTEGER);') },
      {
        version: 2,
        up: (d) =>
          d.exec(
            'CREATE TABLE ok_b (id INTEGER); CREATE TABLE bad (id INTEGER); CREATE TABLE bad (id INTEGER);'
          ),
      },
    ]
    expect(() => migrate(db, list)).toThrow(/bad/)
    // v1 validee, v2 annulee : aucun reliquat de la version fautive.
    expect(userVersion(db)).toBe(1)
    const tables = schemaNames(db, 'table')
    expect(tables.has('ok_a')).toBe(true)
    expect(tables.has('ok_b')).toBe(false)
    expect(tables.has('bad')).toBe(false)
  })
})
