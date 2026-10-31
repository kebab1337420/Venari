import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC, type ProgramDetailData, type ScopeDomain } from '../src/shared/ipc'

type Handler = (event: unknown, raw: unknown) => unknown

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
  repo: {
    createScan: vi.fn<(arg: unknown) => number>(),
    listScans: vi.fn<(programId: string) => unknown[]>(),
    listAllScans: vi.fn<(limit: number) => unknown[]>(),
    getScan: vi.fn<(id: number) => unknown>(),
    getProgram: vi.fn<(id: string) => unknown>(),
    removeScan: vi.fn<(id: number) => void>(),
    listScanEvents: vi.fn<(id: number, after: number) => unknown[]>(),
    listAllScanEvents: vi.fn<(id: number) => unknown[]>(),
  },
  client: { getToken: vi.fn<() => string>() },
  showSaveDialog: vi.fn<() => Promise<unknown>>(),
  fetchProgramDetail: vi.fn<(client: unknown, programId: string) => Promise<unknown>>(),
  getCachedProgramDetail: vi.fn<(programId: string) => unknown>(),
  activeScanCount: vi.fn<() => number>(),
  activeScanForProgram: vi.fn<(programId: string) => unknown>(),
  requestStop: vi.fn<(id: number) => boolean>(),
  startScan: vi.fn<(id: number, plan: unknown) => Promise<void>>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      hoisted.handlers.set(channel, fn)
    },
  },
  dialog: { showSaveDialog: hoisted.showSaveDialog },
}))
vi.mock('../src/main/db', () => ({ getRepository: () => hoisted.repo }))
vi.mock('../src/main/app-state', () => ({ getClient: () => hoisted.client }))
vi.mock('../src/main/services/program-detail', () => ({
  fetchProgramDetail: hoisted.fetchProgramDetail,
  getCachedProgramDetail: hoisted.getCachedProgramDetail,
}))
vi.mock('../src/main/services/scan/runner', () => ({
  activeScanCount: hoisted.activeScanCount,
  activeScanForProgram: hoisted.activeScanForProgram,
  requestStop: hoisted.requestStop,
  startScan: hoisted.startScan,
}))

import { registerScanIpc } from '../src/main/ipc-scan'

const domain = (endpoint: string, inScope = true): ScopeDomain => ({
  id: endpoint,
  type: 'URL',
  endpoint,
  tier: 'Tier 1',
  description: '',
  inScope,
})

function detail(over: Partial<ProgramDetailData> = {}): ProgramDetailData {
  return {
    programId: 'p1',
    handle: 'acme',
    name: 'Acme',
    status: 'open',
    type: 'bug-bounty',
    confidentiality: 'public',
    industry: null,
    webLink: 'https://app.intigriti.com/programs/acme',
    minBounty: null,
    maxBounty: null,
    scope: [domain('https://a.example.com')],
    roe: null,
    fetchedAt: Date.now(),
    ...over,
  }
}

const call = (channel: string, raw: unknown): unknown => hoisted.handlers.get(channel)!(null, raw)

const startPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  programId: 'p1',
  depth: 'low',
  roeConfirm: true,
  ...over,
})

beforeAll(() => {
  registerScanIpc()
})

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.repo.createScan.mockReturnValue(42)
  hoisted.repo.listScans.mockReturnValue([])
  hoisted.repo.listAllScans.mockReturnValue([])
  hoisted.repo.getScan.mockReturnValue(undefined)
  hoisted.repo.getProgram.mockReturnValue(undefined)
  hoisted.repo.listScanEvents.mockReturnValue([])
  hoisted.repo.listAllScanEvents.mockReturnValue([])
  hoisted.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
  hoisted.client.getToken.mockReturnValue('tok')
  hoisted.fetchProgramDetail.mockResolvedValue(detail())
  hoisted.getCachedProgramDetail.mockReturnValue(null)
  hoisted.activeScanCount.mockReturnValue(0)
  hoisted.activeScanForProgram.mockReturnValue(undefined)
  hoisted.requestStop.mockReturnValue(true)
  hoisted.startScan.mockResolvedValue(undefined)
})

describe('ScanStart (gardes du lancement de scan)', () => {
  it('refuse un scan sans confirmation des regles d engagement', async () => {
    const res = await call(IPC.ScanStart, startPayload({ roeConfirm: false }))
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toMatch(/engagement/)
    expect(hoisted.repo.createScan).not.toHaveBeenCalled()
  })

  it('refuse quand le detail du programme est indisponible', async () => {
    hoisted.client.getToken.mockReturnValue('')
    hoisted.getCachedProgramDetail.mockReturnValue(null)
    const res = await call(IPC.ScanStart, startPayload())
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toMatch(/indisponible/)
  })

  it('refuse un scope plus vieux que 24 h', async () => {
    hoisted.fetchProgramDetail.mockResolvedValue(detail({ fetchedAt: Date.now() - 25 * 3600 * 1000 }))
    const res = await call(IPC.ScanStart, startPayload())
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toMatch(/expir/)
  })

  it('refuse quand les outils automatises sont interdits par les regles', async () => {
    hoisted.fetchProgramDetail.mockResolvedValue(
      detail({
        roe: {
          description: '',
          intigritiMe: true,
          automatedTooling: 0,
          userAgent: null,
          requestHeader: null,
          safeHarbour: false,
          attachments: [],
        },
      }),
    )
    const res = await call(IPC.ScanStart, startPayload())
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toMatch(/outils automatis/)
  })

  it('refuse un second scan du meme programme', async () => {
    hoisted.activeScanForProgram.mockReturnValue({})
    const res = await call(IPC.ScanStart, startPayload())
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toMatch(/déjà en cours/)
  })

  it('refuse au-dela de deux scans simultanes', async () => {
    hoisted.activeScanCount.mockReturnValue(2)
    const res = await call(IPC.ScanStart, startPayload())
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toMatch(/simultanés/)
  })

  it('refuse quand aucune cible in-scope exploitable', async () => {
    hoisted.fetchProgramDetail.mockResolvedValue(detail({ scope: [domain('https://a.example.com', false)] }))
    const res = await call(IPC.ScanStart, startPayload())
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toMatch(/Aucune cible/)
    expect(hoisted.startScan).not.toHaveBeenCalled()
  })

  it('refuse un scope trop large (plus de 200 cibles)', async () => {
    const scope = Array.from({ length: 201 }, (_, i) => domain(`https://h${i}.example.com`))
    hoisted.fetchProgramDetail.mockResolvedValue(detail({ scope }))
    const res = await call(IPC.ScanStart, startPayload())
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toMatch(/200/)
    expect(hoisted.startScan).not.toHaveBeenCalled()
  })

  it('cree le scan, lance le moteur et renvoie son id', async () => {
    const res = await call(IPC.ScanStart, startPayload())
    expect(res).toEqual({ ok: true, scanId: 42 })
    expect(hoisted.repo.createScan).toHaveBeenCalledWith({
      programId: 'p1',
      depth: 'low',
      rateLimit: 1,
      roeConfirm: true,
    })
    expect(hoisted.startScan).toHaveBeenCalledWith(42, expect.anything())
  })

  it('utilise le taux de requetes fourni quand present', async () => {
    await call(IPC.ScanStart, startPayload({ rateLimit: 12 }))
    expect(hoisted.repo.createScan).toHaveBeenCalledWith(expect.objectContaining({ rateLimit: 12 }))
  })

  it('renvoie une erreur sur une charge invalide (profondeur inconnue)', async () => {
    const res = await call(IPC.ScanStart, startPayload({ depth: 'ultra' }))
    expect(res).toMatchObject({ ok: false })
    expect(hoisted.repo.createScan).not.toHaveBeenCalled()
  })
})

describe('ScanEvents', () => {
  it('renvoie done=false tant que le scan tourne', () => {
    hoisted.repo.getScan.mockReturnValue({ id: 7, status: 'running' })
    hoisted.repo.listScanEvents.mockReturnValue([{ seq: 1, ts: 10, level: 'info', message: 'go' }])
    const res = call(IPC.ScanEvents, { scanId: 7, afterSeq: 0 })
    expect(res).toEqual({ ok: true, events: [{ seq: 1, ts: 10, level: 'info', message: 'go' }], done: false })
    expect(hoisted.repo.listScanEvents).toHaveBeenCalledWith(7, 0)
  })

  it('renvoie done=true des que le scan est termine', () => {
    hoisted.repo.getScan.mockReturnValue({ id: 7, status: 'done' })
    const res = call(IPC.ScanEvents, { scanId: 7, afterSeq: 3 })
    expect(res).toMatchObject({ ok: true, done: true })
  })

  it('signale un scan introuvable', () => {
    hoisted.repo.getScan.mockReturnValue(undefined)
    const res = call(IPC.ScanEvents, { scanId: 99, afterSeq: 0 })
    expect(res).toMatchObject({ ok: false })
  })
})

describe('ScanListAll (tableau de bord global)', () => {
  it('joint le nom du programme et renvoie les scans du plus recent au plus ancien', () => {
    hoisted.repo.listAllScans.mockReturnValue([
      {
        id: 9,
        program_id: 'p1',
        depth: 'med',
        status: 'running',
        rate_limit: 5,
        roe_confirm: 1,
        started_at: 1000,
        finished_at: null,
        program_name: 'Acme Corp',
        program_handle: 'acme',
      },
    ])
    const res = call(IPC.ScanListAll, undefined)
    expect(res).toEqual({
      ok: true,
      scans: [
        {
          id: 9,
          programId: 'p1',
          depth: 'med',
          status: 'running',
          rateLimit: 5,
          roeConfirm: true,
          startedAt: 1000,
          finishedAt: null,
          programName: 'Acme Corp',
          programHandle: 'acme',
        },
      ],
    })
    expect(hoisted.repo.listAllScans).toHaveBeenCalledWith(200)
  })

  it('replie sur l id du programme quand la fiche a disparu', () => {
    hoisted.repo.listAllScans.mockReturnValue([
      {
        id: 3,
        program_id: 'orphelin',
        depth: 'low',
        status: 'done',
        rate_limit: 1,
        roe_confirm: 0,
        started_at: 0,
        finished_at: 10,
        program_name: null,
        program_handle: null,
      },
    ])
    const res = call(IPC.ScanListAll, undefined) as { scans: { programName: string; programHandle: string }[] }
    expect(res.scans[0]).toMatchObject({ programName: 'orphelin', programHandle: '' })
  })

  it('respecte la limite demandee', () => {
    call(IPC.ScanListAll, 25)
    expect(hoisted.repo.listAllScans).toHaveBeenCalledWith(25)
  })

  it('refuse une limite hors bornes', () => {
    const res = call(IPC.ScanListAll, 0)
    expect(res).toMatchObject({ ok: false })
    expect(hoisted.repo.listAllScans).not.toHaveBeenCalled()
  })

  it('renvoie une erreur quand la base echoue', () => {
    hoisted.repo.listAllScans.mockImplementation(() => {
      throw new Error('db verrouillee')
    })
    const res = call(IPC.ScanListAll, undefined)
    expect(res).toEqual({ ok: false, error: 'db verrouillee' })
  })
})

describe('ScanStop', () => {
  it('transmet la demande d arret', () => {
    const res = call(IPC.ScanStop, 7)
    expect(res).toEqual({ ok: true, stopped: true })
    expect(hoisted.requestStop).toHaveBeenCalledWith(7)
  })
})

describe('ScanExportLog', () => {
  const scanRow = {
    id: 7,
    program_id: 'p1',
    depth: 'low',
    status: 'done',
    rate_limit: 2,
    roe_confirm: 1,
    started_at: 1_000,
    finished_at: 5_000,
  }

  it('ecrit le journal complet dans le fichier choisi', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'venari-scan-log-'))
    const target = join(dir, 'journal.txt')
    try {
      hoisted.repo.getScan.mockReturnValue(scanRow)
      hoisted.repo.getProgram.mockReturnValue({ name: 'Acme', handle: 'acme' })
      hoisted.repo.listAllScanEvents.mockReturnValue([
        { seq: 1, ts: 2_000, level: 'info', message: 'debut' },
        { seq: 2, ts: 3_000, level: 'error', message: 'boum' },
      ])
      hoisted.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })

      const res = await call(IPC.ScanExportLog, 7)
      expect(res).toEqual({ ok: true, path: target, events: 2 })
      expect(hoisted.repo.listAllScanEvents).toHaveBeenCalledWith(7)
      expect(hoisted.showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({ defaultPath: 'scan-7-acme.txt' }),
      )
      const text = readFileSync(target, 'utf8')
      expect(text).toContain('Programme : Acme (@acme)')
      expect(text).toContain('[1970-01-01T00:00:02.000Z] [info] debut')
      expect(text).toContain('[1970-01-01T00:00:03.000Z] [error] boum')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rapporte l annulation sans ecrire de fichier', async () => {
    hoisted.repo.getScan.mockReturnValue(scanRow)
    hoisted.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const res = await call(IPC.ScanExportLog, 7)
    expect(res).toEqual({ ok: false, error: 'Export annulé.', canceled: true })
  })

  it('refuse un scan inconnu avant d ouvrir le selecteur', async () => {
    hoisted.repo.getScan.mockReturnValue(undefined)
    const res = await call(IPC.ScanExportLog, 99)
    expect(res).toMatchObject({ ok: false })
    expect(hoisted.showSaveDialog).not.toHaveBeenCalled()
  })

  it('rejette un identifiant invalide', async () => {
    const res = await call(IPC.ScanExportLog, 0)
    expect(res).toMatchObject({ ok: false })
    expect(hoisted.repo.getScan).not.toHaveBeenCalled()
  })
})

describe('ScanRemove', () => {
  it('supprime le scan', () => {
    const res = call(IPC.ScanRemove, 7)
    expect(res).toEqual({ ok: true })
    expect(hoisted.repo.removeScan).toHaveBeenCalledWith(7)
  })

  it('rejette un id invalide', () => {
    const res = call(IPC.ScanRemove, 0)
    expect(res).toMatchObject({ ok: false })
  })
})
