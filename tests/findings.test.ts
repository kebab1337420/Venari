import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/db'
import { createRepository, type Repository } from '../src/main/db/repo'

let db: Db
let repo: Repository

function seedProgram(id = 'prog-1'): void {
  repo.upsertProgram({
    id,
    handle: 'acme',
    name: 'Acme Corp',
    type: 'public',
    status: 'active',
    confidentiality: 'public',
    minBounty: null,
    maxBounty: null,
    industry: 'Software',
    webLink: null,
    following: false,
    rawJson: null,
  })
}

function finding(overrides: Partial<Parameters<Repository['createFinding']>[0]> = {}): number {
  return repo.createFinding({
    programId: 'prog-1',
    asset: 'https://app.acme.example/admin',
    title: 'IDOR sur /admin',
    severity: 'high',
    cvss: 7.5,
    description: 'Un utilisateur lit les factures des autres.',
    poc: 'GET /admin?user=2',
    scanId: null,
    reportPath: null,
    ...overrides,
  })
}

beforeEach(() => {
  db = openDatabase(':memory:')
  repo = createRepository(db)
  seedProgram()
})

describe('findings', () => {
  it('cree un finding et le relit avec le nom du programme', () => {
    const id = finding()
    const row = repo.getFinding(id)!
    expect(row).toMatchObject({
      program_id: 'prog-1',
      program_name: 'Acme Corp',
      title: 'IDOR sur /admin',
      severity: 'high',
      cvss: 7.5,
      status: 'open',
      report_path: null,
    })
  })

  it('filtre par programme, statut, severite et recherche', () => {
    seedProgram('prog-2')
    const a = finding()
    finding({ programId: 'prog-2', title: 'XSS', severity: 'medium', status: 'triaged', description: 'Script injecté.' })
    repo.updateFinding(a, { status: 'reported' })

    expect(repo.listFindings({ status: 'reported' }).map((f) => f.id)).toEqual([a])
    expect(repo.listFindings({ severity: 'medium' })).toHaveLength(1)
    expect(repo.listFindings({ programId: 'prog-1' })).toHaveLength(1)
    expect(repo.listFindings({ search: 'xss' })).toHaveLength(1)
    expect(repo.listFindings({ search: 'factures' })).toHaveLength(1)
  })

  it('met a jour partiellement et horodate', () => {
    const id = finding()
    repo.updateFinding(id, { status: 'triaged', cvss: null })
    const row = repo.getFinding(id)!
    expect(row.status).toBe('triaged')
    expect(row.cvss).toBeNull()
    expect(row.updated_at).toBeGreaterThanOrEqual(row.created_at)
  })

  it('refuse une mise a jour video et une suppression inconnue', () => {
    expect(() => repo.updateFinding(999, { status: 'fixed' })).toThrow('Finding introuvable')
    expect(() => repo.removeFinding(999)).toThrow('Finding introuvable')
  })

  it('compte par statut, globalement et par programme', () => {
    const a = finding()
    finding({ status: 'reported', title: 'Autre' })
    repo.updateFinding(a, { status: 'reported' })
    expect(repo.findingStats()).toMatchObject({ total: 2, reported: 2 })
    expect(repo.findingStats('prog-1')).toMatchObject({ total: 2, reported: 2 })
    expect(repo.findingStats('inconnu')).toEqual({ total: 0 })
  })

  it('detecte un doublon a la casse et aux espaces pres', () => {
    const id = finding({ title: '  IDOR sur /admin ', asset: 'HTTPS://app.acme.example/admin' })
    expect(repo.findDuplicateFinding('prog-1', 'https://app.acme.example/admin', 'idor sur /admin')?.id).toBe(id)
    expect(repo.findDuplicateFinding('prog-1', 'https://autre.example', 'IDOR sur /admin')).toBeUndefined()
    expect(repo.findDuplicateFinding('prog-2', 'HTTPS://app.acme.example/admin', 'IDOR sur /admin')).toBeUndefined()
  })

  it('supprime en cascade avec le programme', () => {
    finding()
    db.exec("DELETE FROM programs WHERE id = 'prog-1'")
    expect(repo.listFindings()).toHaveLength(0)
  })
})
