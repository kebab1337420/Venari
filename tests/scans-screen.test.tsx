// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ScanOverview } from '../src/shared/ipc'

const api = vi.hoisted(() => ({
  scans: { listAll: vi.fn(), events: vi.fn(), stop: vi.fn() },
}))

vi.mock('../src/renderer/src/api', () => ({ Api: api }))

import { ScansScreen } from '../src/renderer/src/screens/Scans'

afterEach(cleanup)

const scan = (over: Partial<ScanOverview> = {}): ScanOverview => ({
  id: 7,
  programId: 'p1',
  depth: 'med',
  status: 'done',
  rateLimit: 5,
  roeConfirm: true,
  startedAt: 1_000,
  finishedAt: 61_000,
  programName: 'Acme Corp',
  programHandle: 'acme',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.scans.listAll.mockResolvedValue({ ok: true, scans: [scan()] })
  api.scans.events.mockResolvedValue({ ok: true, events: [], done: true })
  api.scans.stop.mockResolvedValue({ ok: true })
})

describe('ScansScreen', () => {
  it('affiche les scans avec programme, profondeur et statut', async () => {
    render(<ScansScreen />)

    expect(await screen.findByText('Acme Corp')).toBeTruthy()
    expect(screen.getByText('@acme')).toBeTruthy()
    expect(screen.getByText('Moyen')).toBeTruthy()
    expect(screen.getByText('terminé')).toBeTruthy()
    expect(screen.getByText('1 min 0 s')).toBeTruthy()
  })

  it('invite a lancer un scan quand il n y en a aucun', async () => {
    api.scans.listAll.mockResolvedValue({ ok: true, scans: [] })
    render(<ScansScreen />)

    expect(await screen.findByText(/Aucun scan pour l’instant/)).toBeTruthy()
  })

  it('signale un echec de chargement sans planter', async () => {
    api.scans.listAll.mockResolvedValue({ ok: false, error: 'db verrouillee' })
    render(<ScansScreen />)

    expect(await screen.findByText('db verrouillee')).toBeTruthy()
  })

  it('signale un rejet IPC du chargement', async () => {
    api.scans.listAll.mockRejectedValue(new Error('pont IPC coupe'))
    render(<ScansScreen />)

    expect(await screen.findByText('Impossible de charger les scans : pont IPC coupe')).toBeTruthy()
  })

  it('rafraichit la liste a la demande', async () => {
    render(<ScansScreen />)
    await screen.findByText('Acme Corp')

    fireEvent.click(screen.getByText('Rafraîchir'))

    await waitFor(() => expect(api.scans.listAll).toHaveBeenCalledTimes(2))
  })

  it('ouvre le journal d un scan termine', async () => {
    render(<ScansScreen />)

    fireEvent.click(await screen.findByText('Journal'))

    expect(await screen.findByText('Scan terminé — Acme Corp')).toBeTruthy()
    expect(api.scans.events).toHaveBeenCalledWith(7, 0)
  })

  it('suit un scan en cours et permet de l arreter', async () => {
    api.scans.listAll.mockResolvedValue({
      ok: true,
      scans: [scan({ status: 'running', finishedAt: null })],
    })
    api.scans.events.mockResolvedValue({ ok: true, events: [], done: false })
    render(<ScansScreen />)

    fireEvent.click(await screen.findByText('Suivre'))
    expect(await screen.findByText('Scan en cours — Acme Corp')).toBeTruthy()

    fireEvent.click(screen.getByText('■ Arrêter'))

    await waitFor(() => expect(api.scans.stop).toHaveBeenCalledWith(7))
  })

  it('affiche le nombre de scans en cours', async () => {
    api.scans.listAll.mockResolvedValue({
      ok: true,
      scans: [scan({ status: 'running', finishedAt: null }), scan({ id: 8 })],
    })
    render(<ScansScreen />)

    expect(await screen.findByText('1 scan en cours')).toBeTruthy()
  })
})
