import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  const repo = {
    createScan: vi.fn(),
    listScans: vi.fn(),
    getScan: vi.fn(),
    listScanEvents: vi.fn(),
  }
  return {
    handlers,
    repo,
    getRepository: vi.fn(),
    getClient: vi.fn(),
    fetchProgramDetail: vi.fn(),
    getCachedProgramDetail: vi.fn(),
    activeScanForProgram: vi.fn(),
    activeScanCount: vi.fn(),
    requestStop: vi.fn(),
    startScan: vi.fn(),
    selectTargets: vi.fn(),
    buildPlan: vi.fn(),
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => Promise<any>) => {
      h.handlers.set(channel, fn)
    },
  },
}))

vi.mock('../src/main/db', () => ({ getRepository: h.getRepository }))
vi.mock('../src/main/app-state', () => ({ getClient: h.getClient }))
vi.mock('../src/main/services/program-detail', () => ({
  fetchProgramDetail: h.fetchProgramDetail,
  getCachedProgramDetail: h.getCachedProgramDetail,
}))
vi.mock('../src/main/services/scan/runner', () => ({
  activeScanForProgram: h.activeScanForProgram,
  activeScanCount: h.activeScanCount,
  requestStop: h.requestStop,
  startScan: h.startScan,
}))
vi.mock('../src/main/services/scan/plan', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, selectTargets: h.selectTargets, buildPlan: h.buildPlan }
})

import { registerScanIpc } from '../src/main/ipc-scan'
import { IPC } from '../src/shared/ipc'
import { MAX_TARGETS } from '../src/main/services/scan/plan'

function handler(channel: string): (...args: any[]) => any {
  const fn = h.handlers.get(channel)
  if (!fn) throw new Error(`handler absent: ${channel}`)
  return fn
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    programId: 'p1',
    handle: 'p1',
    name: 'Programme P1',
    status: 'active',
    type: 'bug_bounty',
    confidentiality: 'public',
    industry: null,
    webLink: null,
    minBounty: null,
    maxBounty: null,
    scope: [{ id: 'd1', endpoint: 'https://api.p1.example', inScope: true }],
    roe: {
      description: 'r',
      intigritiMe: false,
      automatedTooling: 1,
      userAgent: 'Venari',
      requestHeader: 'X-Venari: 1',
      safeHarbour: true,
      attachments: [],
    },
    fetchedAt: Date.now(),
    ...overrides,
  }
}

function startPayload(overrides: Record<string, unknown> = {}) {
  return { programId: 'p1', depth: 'low', roeConfirm: true, ...overrides }
}

beforeEach(() => {
  h.handlers.clear()
  for (const fn of Object.values(h.repo)) fn.mockReset()
  h.getRepository.mockReset()
  h.getClient.mockReset()
  h.fetchProgramDetail.mockReset()
  h.getCachedProgramDetail.mockReset()
  h.activeScanForProgram.mockReset()
  h.activeScanCount.mockReset()
  h.requestStop.mockReset()
  h.startScan.mockReset()
  h.selectTargets.mockReset()
  h.buildPlan.mockReset()

  h.getRepository.mockReturnValue(h.repo)
  h.getClient.mockReturnValue({ getToken: () => 'jeton' })
  h.fetchProgramDetail.mockResolvedValue(detail())
  h.activeScanForProgram.mockReturnValue(undefined)
  h.activeScanCount.mockReturnValue(0)
  h.selectTargets.mockReturnValue([{ url: 'https://api.p1.example' }])
  h.buildPlan.mockReturnValue({ steps: ['a'] })
  h.repo.createScan.mockReturnValue(42)
  h.repo.listScans.mockReturnValue([])
  h.repo.getScan.mockReturnValue({ id: 42, status: 'running' })
  h.repo.listScanEvents.mockReturnValue([])
  h.requestStop.mockReturnValue(true)

  registerScanIpc()
})

describe('scan:start - validation', () => {
  it('rejette un payload invalide', async () => {
    await expect(handler(IPC.ScanStart)(null, {})).rejects.toThrow()
    await expect(handler(IPC.ScanStart)(null, startPayload({ depth: 'extreme' }))).rejects.toThrow()
    await expect(handler(IPC.ScanStart)(null, startPayload({ rateLimit: 0 }))).rejects.toThrow()
    await expect(handler(IPC.ScanStart)(null, startPayload({ programId: '' }))).rejects.toThrow()
  })

  it('refuse sans la confirmation des regles d engagement', async () => {
    const result = await handler(IPC.ScanStart)(null, startPayload({ roeConfirm: false }))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('confirmation')
    expect(h.repo.createScan).not.toHaveBeenCalled()
    expect(h.startScan).not.toHaveBeenCalled()
  })
})

describe('scan:start - garde-fous', () => {
  it('refuse quand le detail est introuvable', async () => {
    h.fetchProgramDetail.mockResolvedValue(null)
    h.getCachedProgramDetail.mockReturnValue(null)
    const result = await handler(IPC.ScanStart)(null, startPayload())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Détail du programme indisponible')
  })

  it('refuse un scope plus ancien que 24 heures', async () => {
    h.fetchProgramDetail.mockResolvedValue(detail({ fetchedAt: Date.now() - 25 * 3600 * 1000 }))
    const result = await handler(IPC.ScanStart)(null, startPayload())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Scope expiré')
    expect(h.repo.createScan).not.toHaveBeenCalled()
  })

  it('refuse un programme dont les regles interdisent les outils automatises', async () => {
    h.fetchProgramDetail.mockResolvedValue(
      detail({ roe: { ...detail().roe, automatedTooling: 0 } }),
    )
    const result = await handler(IPC.ScanStart)(null, startPayload())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('outils automatisés')
    expect(h.repo.createScan).not.toHaveBeenCalled()
  })

  it('refuse un doublon de scan pour le meme programme', async () => {
    h.activeScanForProgram.mockReturnValue({ id: 7 })
    const result = await handler(IPC.ScanStart)(null, startPayload())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('déjà en cours')
  })

  it('refuse plus de deux scans simultanes', async () => {
    h.activeScanCount.mockReturnValue(2)
    const result = await handler(IPC.ScanStart)(null, startPayload())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Trop de scans simultanés')
    expect(h.repo.createScan).not.toHaveBeenCalled()
  })

  it('refuse un programme sans cible http(s) in-scope', async () => {
    h.selectTargets.mockReturnValue([])
    const result = await handler(IPC.ScanStart)(null, startPayload())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Aucune cible in-scope')
    expect(h.repo.createScan).not.toHaveBeenCalled()
  })

  it('refuse un scope plus large que la limite', async () => {
    h.selectTargets.mockReturnValue(Array.from({ length: MAX_TARGETS + 1 }, (_, i) => ({ url: `https://h${i}.example` })))
    const result = await handler(IPC.ScanStart)(null, startPayload())
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Scope trop large')
    expect(result.error).toContain(String(MAX_TARGETS + 1))
  })
})

describe('scan:start - parcours nominal', () => {
  it('persiste le scan, construit le plan et demarre', async () => {
    h.fetchProgramDetail.mockResolvedValue(detail())

    const result = await handler(IPC.ScanStart)(null, startPayload({ depth: 'low' }))

    expect(result).toEqual({ ok: true, scanId: 42 })
    expect(h.fetchProgramDetail).toHaveBeenCalledWith(expect.anything(), 'p1')
    expect(h.repo.createScan).toHaveBeenCalledWith({
      programId: 'p1',
      depth: 'low',
      rateLimit: 1,
      roeConfirm: true,
    })
    expect(h.buildPlan).toHaveBeenCalledWith('low', [{ url: 'https://api.p1.example' }], 1, {
      userAgent: 'Venari',
      requestHeader: 'X-Venari: 1',
    })
    expect(h.startScan).toHaveBeenCalledWith(42, { steps: ['a'] })
  })

  it('applique le debit par defaut de la profondeur', async () => {
    await handler(IPC.ScanStart)(null, startPayload({ depth: 'med' }))
    expect(h.repo.createScan).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 'med', rateLimit: 5 }),
    )

    await handler(IPC.ScanStart)(null, startPayload({ depth: 'high' }))
    expect(h.repo.createScan).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 'high', rateLimit: 10 }),
    )
  })

  it('laisse le debit explicite passer avant celui par defaut', async () => {
    await handler(IPC.ScanStart)(null, startPayload({ depth: 'high', rateLimit: 3 }))
    expect(h.repo.createScan).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimit: 3 }),
    )
  })

  it('utilise le detail en cache quand aucun jeton n est present', async () => {
    h.getClient.mockReturnValue({ getToken: () => null })
    h.getCachedProgramDetail.mockReturnValue(detail())

    const result = await handler(IPC.ScanStart)(null, startPayload())

    expect(result.ok).toBe(true)
    expect(h.fetchProgramDetail).not.toHaveBeenCalled()
    expect(h.getCachedProgramDetail).toHaveBeenCalledWith('p1')
  })

  it('encapsule les erreurs sans rejetter la promesse', async () => {
    h.fetchProgramDetail.mockRejectedValue(new Error('reseau coupe'))
    await expect(handler(IPC.ScanStart)(null, startPayload())).resolves.toEqual({
      ok: false,
      error: 'reseau coupe',
    })

    h.fetchProgramDetail.mockRejectedValue('42')
    await expect(handler(IPC.ScanStart)(null, startPayload())).resolves.toEqual({
      ok: false,
      error: '42',
    })
  })
})

describe('scan:list', () => {
  it('mappe les scans et convertit roe_confirm en booleen', async () => {
    h.repo.listScans.mockReturnValue([
      {
        id: 3,
        program_id: 'p1',
        depth: 'med',
        status: 'done',
        rate_limit: 5,
        roe_confirm: 1,
        started_at: 111,
        finished_at: 222,
      },
    ])

    const result = handler(IPC.ScanList)(null, 'p1')
    expect(result).toEqual({
      ok: true,
      scans: [
        {
          id: 3,
          programId: 'p1',
          depth: 'med',
          status: 'done',
          rateLimit: 5,
          roeConfirm: true,
          startedAt: 111,
          finishedAt: 222,
        },
      ],
    })
  })

  it('encapsule une erreur de base', async () => {
    h.repo.listScans.mockImplementation(() => {
      throw new Error('base verrouillee')
    })
    expect(handler(IPC.ScanList)(null, 'p1')).toEqual({
      ok: false,
      error: 'base verrouillee',
    })
  })

  it('rejette un identifiant de programme invalide', () => {
    expect(() => handler(IPC.ScanList)(null, '')).toThrow()
  })
})

describe('scan:events', () => {
  it('signale un scan introuvable', async () => {
    h.repo.getScan.mockReturnValue(null)
    const result = await handler(IPC.ScanEvents)(null, { scanId: 42, afterSeq: 0 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('42')
  })

  it('met done selon l etat du scan et mappe les evenements', async () => {
    h.repo.getScan.mockReturnValue({ id: 42, status: 'running' })
    h.repo.listScanEvents.mockReturnValue([
      { seq: 1, ts: 10, level: 'info', message: 'demarrage' },
    ])

    const running = await handler(IPC.ScanEvents)(null, { scanId: 42, afterSeq: 0 })
    expect(running).toEqual({
      ok: true,
      events: [{ seq: 1, ts: 10, level: 'info', message: 'demarrage' }],
      done: false,
    })
    expect(h.repo.listScanEvents).toHaveBeenCalledWith(42, 0)

    h.repo.getScan.mockReturnValue({ id: 42, status: 'finished' })
    const finished = await handler(IPC.ScanEvents)(null, { scanId: 42, afterSeq: 1 })
    expect(finished.done).toBe(true)
  })

  it('rejette un afterSeq hors bornes', () => {
    expect(() => handler(IPC.ScanEvents)(null, { scanId: 42, afterSeq: -1 })).toThrow()
    expect(() => handler(IPC.ScanEvents)(null, { scanId: 0, afterSeq: 0 })).toThrow()
  })
})

describe('scan:stop', () => {
  it('renvoie l issue de l arret', async () => {
    expect(handler(IPC.ScanStop)(null, 42)).toEqual({ ok: true, stopped: true })
    expect(h.requestStop).toHaveBeenCalledWith(42)

    h.requestStop.mockReturnValue(false)
    expect(handler(IPC.ScanStop)(null, 42)).toEqual({ ok: true, stopped: false })
  })

  it('rejette un identifiant de scan invalide', () => {
    expect(() => handler(IPC.ScanStop)(null, 0)).toThrow()
    expect(() => handler(IPC.ScanStop)(null, -1)).toThrow()
  })
})
