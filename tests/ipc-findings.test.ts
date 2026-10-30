import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/shared/ipc'
import { openDatabase, type Db } from '../src/main/db/db'
import { createRepository, type Repository } from '../src/main/db/repo'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
  showItemInFolder: vi.fn(),
  openPath: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\tmp\\venari-test' },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) => {
      h.handlers.set(channel, fn)
    },
  },
  shell: { showItemInFolder: h.showItemInFolder, openPath: h.openPath },
}))

let db: Db
let repo: Repository

vi.mock('../src/main/db', () => ({ getRepository: () => repo }))

import { registerFindingsIpc } from '../src/main/ipc-findings'

const call = (channel: string, raw?: unknown): unknown => h.handlers.get(channel)!(null, raw)

const INPUT = { programId: 'p1', title: 'IDOR factures', asset: 'https://a.example/f', severity: 'high' }

beforeAll(() => {
  registerFindingsIpc()
})

beforeEach(() => {
  db = openDatabase(':memory:')
  repo = createRepository(db)
  repo.upsertProgram({
    id: 'p1',
    handle: 'acme',
    name: 'Acme',
    type: 'public',
    status: 'active',
    confidentiality: 'public',
    minBounty: null,
    maxBounty: null,
    industry: null,
    webLink: null,
    following: false,
    rawJson: null,
  })
})

describe('IPC findings', () => {
  it('cree, liste et met a jour un finding', () => {
    const created = call(IPC.FindingsCreate, INPUT) as { ok: boolean; id: number }
    expect(created.ok).toBe(true)
    const list = call(IPC.FindingsList, { programId: 'p1' }) as { ok: boolean; findings: { id: number; programName: string }[] }
    expect(list.findings).toHaveLength(1)
    expect(list.findings[0]).toMatchObject({ id: created.id, programName: 'Acme' })
    expect(call(IPC.FindingsUpdate, { id: created.id, patch: { status: 'triaged' } })).toEqual({ ok: true })
    const stats = call(IPC.FindingsStats, 'p1') as { ok: boolean; stats: Record<string, number> }
    expect(stats.stats).toMatchObject({ total: 1, triaged: 1 })
  })

  it('refuse un programme inconnu, un statut invalide et un id inconnu', () => {
    expect(call(IPC.FindingsCreate, { ...INPUT, programId: 'inconnu' })).toMatchObject({ ok: false })
    expect(call(IPC.FindingsCreate, { ...INPUT, status: 'pas-un-statut' })).toMatchObject({ ok: false })
    expect(call(IPC.FindingsUpdate, { id: 999, patch: { status: 'fixed' } })).toMatchObject({ ok: false })
    expect(call(IPC.FindingsRemove, 999)).toMatchObject({ ok: false })
  })

  it('refuse un chemin de rapport hors du dossier et supprime', () => {
    expect(call(IPC.FindingsCreate, { ...INPUT, reportPath: '../secret.md' })).toMatchObject({ ok: false })
    const created = call(IPC.FindingsCreate, INPUT) as { id: number }
    expect(call(IPC.FindingsRemove, created.id)).toEqual({ ok: true })
    expect(call(IPC.FindingsList, {})).toMatchObject({ ok: true, findings: [] })
  })

  it('lit un rapport inconnu sans planter', () => {
    expect(call(IPC.ReportsRead, 'p1/absent.md')).toMatchObject({ ok: false })
  })
})
