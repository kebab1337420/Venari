import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc'

type Handler = (event: unknown, raw: unknown) => unknown

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
  root: '',
  openPath: vi.fn<(path: string) => Promise<string>>(),
  show: vi.fn<(path: string) => void>(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => hoisted.root },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      hoisted.handlers.set(channel, fn)
    },
  },
  shell: {
    openPath: hoisted.openPath,
    showItemInFolder: hoisted.show,
  },
}))

import { registerReportsIpc } from '../src/main/ipc-reports'

const call = (channel: string, raw: unknown): unknown => hoisted.handlers.get(channel)!(null, raw)

beforeAll(() => {
  registerReportsIpc()
})

beforeEach(() => {
  hoisted.root = mkdtempSync(join(tmpdir(), 'venari-reports-'))
  hoisted.openPath.mockReset()
  hoisted.openPath.mockResolvedValue('')
  hoisted.show.mockReset()
})

afterEach(() => {
  rmSync(hoisted.root, { recursive: true, force: true })
})

const write = (programId: string, name: string, body = '# rapport'): string => {
  const dir = join(hoisted.root, 'reports', programId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, body)
  return file
}

describe('ReportsList', () => {
  it('renvoie une liste vide quand aucun rapport n existe', async () => {
    expect(await call(IPC.ReportsList, undefined)).toEqual({ ok: true, reports: [] })
  })

  it('ne liste que les .md des sous-dossiers, du plus recent au plus ancien', async () => {
    const old = write('p1', 'ancien.md')
    const recent = write('p2', 'recent.md')
    write('p1', 'notes.txt')
    mkdirSync(join(hoisted.root, 'reports', 'p1', 'nested'))

    const past = new Date(Date.now() - 60_000)
    utimesSync(old, past, past)

    const res = (await call(IPC.ReportsList, undefined)) as {
      ok: true
      reports: { programId: string; name: string; path: string; size: number }[]
    }
    expect(res.ok).toBe(true)
    expect(res.reports.map((r) => r.name)).toEqual(['recent.md', 'ancien.md'])
    expect(res.reports[0]).toMatchObject({ programId: 'p2', path: recent })
    expect(res.reports[1]).toMatchObject({ programId: 'p1', path: old })
    expect(res.reports[0]!.size).toBeGreaterThan(0)
  })
})

describe('ReportsOpen', () => {
  it('ouvre le fichier resolu dans le dossier des rapports', async () => {
    const file = write('p1', 'a.md')
    const res = await call(IPC.ReportsOpen, { programId: 'p1', name: 'a.md' })
    expect(res).toEqual({ ok: true })
    expect(hoisted.openPath).toHaveBeenCalledWith(file)
  })

  it('remonte l erreur du systeme quand l ouverture echoue', async () => {
    hoisted.openPath.mockResolvedValue('fichier absent')
    const res = await call(IPC.ReportsOpen, { programId: 'p1', name: 'a.md' })
    expect(res).toEqual({ ok: false, error: 'fichier absent' })
  })

  it('refuse un nom qui tente de sortir du dossier', async () => {
    const res = await call(IPC.ReportsOpen, { programId: 'p1', name: '../evil.md' })
    expect(res).toMatchObject({ ok: false })
    expect(hoisted.openPath).not.toHaveBeenCalled()
  })

  it('refuse un programme invalide', async () => {
    const res = await call(IPC.ReportsOpen, { programId: '..', name: 'a.md' })
    expect(res).toMatchObject({ ok: false })
    expect(hoisted.openPath).not.toHaveBeenCalled()
  })

  it('refuse un fichier non markdown', async () => {
    const res = await call(IPC.ReportsOpen, { programId: 'p1', name: 'a.txt' })
    expect(res).toMatchObject({ ok: false })
  })
})

describe('ReportsReveal', () => {
  it('revele le fichier dans l explorateur', () => {
    const file = write('p1', 'a.md')
    const res = call(IPC.ReportsReveal, { programId: 'p1', name: 'a.md' })
    expect(res).toEqual({ ok: true })
    expect(hoisted.show).toHaveBeenCalledWith(file)
  })

  it('refuse un chemin invalide sans rien reveler', () => {
    const res = call(IPC.ReportsReveal, { programId: 'p1', name: '../../secret.md' })
    expect(res).toMatchObject({ ok: false })
    expect(hoisted.show).not.toHaveBeenCalled()
  })
})
