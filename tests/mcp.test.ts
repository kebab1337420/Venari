import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'bountydesk-mcp-test-'))
const plainSecret = 's3cret-test-value'

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
  installTool: async (id: string) => ({ ok: true as const, installed: true }),
}))

import { closeDb, getRepository } from '../src/main/db'
import { callTool } from '../src/main/services/mcp/server'
import type { ProgramInput } from '../src/main/db/repo'

function seedProgram(): void {
  const repo = getRepository()
  const p: ProgramInput = {
    id: 'prog-1',
    handle: 'acme-redteam',
    name: 'Acme Red Team',
    type: 'bug_bounty',
    status: 'active',
    confidentiality: 'public',
    minBounty: null,
    maxBounty: { value: 5000, currency: 'EUR' },
    industry: 'software',
    webLink: 'https://example.com/rt',
    following: true,
    rawJson: null,
  }
  repo.upsertPrograms([p])
}

describe('MCP tools', () => {
  beforeEach(() => {
    closeDb()
    rmSync(join(userData, 'bountydesk.db'), { force: true })
    rmSync(join(userData, 'bountydesk.db-wal'), { force: true })
    rmSync(join(userData, 'bountydesk.db-shm'), { force: true })
    const repo = getRepository()
    seedProgram()
    repo.setFavorite('prog-1', true)
    repo.setProgramDetail('prog-1', JSON.stringify([{ id: 'd1', type: 'In Scope', endpoint: 'https://app.acme.com', tier: 'L1', description: '', inScope: true }]), JSON.stringify({ description: 'no automated tools', intigritiMe: true, automatedTooling: null, userAgent: null, requestHeader: null, safeHarbour: true, attachments: [] }), 1000)
    repo.createCredential({ programId: 'prog-1', label: 'test', username: 'bob', secretEnc: plainSecret, note: 'test cred' })
  })

  it('list_programs renvoie les programmes stockés', async () => {
    const res = await callTool('list_programs', {})
    const parsed = JSON.parse(res.text) as { id: string; handle: string; favorite: boolean; maxBounty: { value: number } }[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.id).toBe('prog-1')
    expect(parsed[0]!.handle).toBe('acme-redteam')
    expect(parsed[0]!.favorite).toBe(true)
    expect(parsed[0]!.maxBounty?.value).toBe(5000)
  })

  it('list_programs filtre par recherche et favoris', async () => {
    const repo = getRepository()
    repo.upsertPrograms([{ ...({ id: 'prog-2', handle: 'other', name: 'Zorg', type: null, status: 'closed', confidentiality: null, minBounty: null, maxBounty: null, industry: null, webLink: null, following: false, rawJson: null } as ProgramInput) }])
    const search = await callTool('list_programs', { search: 'zorg' })
    expect(JSON.parse(search.text)).toHaveLength(1)
    const fav = await callTool('list_programs', { favoriteOnly: true })
    expect(JSON.parse(fav.text)).toHaveLength(1)
  })

  it('list_programs se pagine et annonce le reste à lire', async () => {
    const repo = getRepository()
    repo.upsertPrograms(
      [2, 3, 4].map((i) => ({ ...({ id: `prog-${i}`, handle: `h${i}`, name: `Prog ${i}`, type: null, status: null, confidentiality: null, minBounty: null, maxBounty: null, industry: null, webLink: null, following: false, rawJson: null } as ProgramInput) })),
    )

    const page1 = await callTool('list_programs', { limit: 2, offset: 0 })
    expect(JSON.parse(page1.text)).toHaveLength(2)
    expect(page1.details).toMatchObject({ count: 2, total: 4, offset: 0, hasMore: true })

    const page2 = await callTool('list_programs', { limit: 2, offset: 2 })
    expect(JSON.parse(page2.text)).toHaveLength(2)
    expect(page2.details).toMatchObject({ count: 2, total: 4, offset: 2, hasMore: false })

    const bad = await callTool('list_programs', { limit: 0 })
    expect(bad.isError).toBe(true)
  })

  it('get_program_detail renvoie scope et ROE depuis le cache', async () => {
    const res = await callTool('get_program_detail', { programId: 'prog-1' })
    expect(res.isError).toBeUndefined()
    const parsed = JSON.parse(res.text) as { scope: { endpoint: string }[]; roe: { safeHarbour: boolean } | null }
    expect(parsed.scope[0]?.endpoint).toBe('https://app.acme.com')
    expect(parsed.roe?.safeHarbour).toBe(true)
  })

  it('get_program_detail échoue proprement si programme inconnu', async () => {
    const res = await callTool('get_program_detail', { programId: 'inconnu' })
    expect(res.isError).toBe(true)
  })

  it('list_credentials n’expose jamais le secret', async () => {
    const res = await callTool('list_credentials', { programId: 'prog-1' })
    const parsed = JSON.parse(res.text) as { username: string; label: string }[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.username).toBe('bob')
    expect(res.text).not.toContain(plainSecret)
  })

  it('start_scan n’exige plus roeConfirm (contrôle ROE optionnel)', async () => {
    const res = await callTool('start_scan', { programId: 'prog-1', depth: 'low', roeConfirm: false })
    // L’ancien refus « confirmation des règles d’engagement requise » a disparu :
    // l’appel franchit ce contrôle. Ici il échoue plus loin, sur la fraîcheur du scope.
    expect(res.text).not.toContain('confirmation')
    expect(res.text).not.toContain('règles d’engagement')
  })

  it('start_scan refuse un depth invalide', async () => {
    const res = await callTool('start_scan', { programId: 'prog-1', depth: 'max', roeConfirm: true })
    expect(res.isError).toBe(true)
  })

  it('get_scan et scan_events renvoient un scan créé', async () => {
    const repo = getRepository()
    const id = repo.createScan({ programId: 'prog-1', depth: 'low', rateLimit: 2, roeConfirm: true })
    const scan = await callTool('get_scan', { scanId: id })
    const s = JSON.parse(scan.text) as { id: number; status: string }
    expect(s.id).toBe(id)
    expect(s.status).toBe('running')
    const ev = await callTool('scan_events', { scanId: id })
    const e = JSON.parse(ev.text) as { events: unknown[]; done: boolean }
    expect(Array.isArray(e.events)).toBe(true)
    expect(e.done).toBe(false)
  })
})