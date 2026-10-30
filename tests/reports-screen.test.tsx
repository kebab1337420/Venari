// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReportFile } from '../src/shared/ipc'

const api = vi.hoisted(() => ({
  reports: { list: vi.fn(), open: vi.fn(), reveal: vi.fn() },
}))

vi.mock('../src/renderer/src/api', () => ({ Api: api }))

import { ReportsScreen } from '../src/renderer/src/screens/Reports'

afterEach(cleanup)

const report = (over: Partial<ReportFile> = {}): ReportFile => ({
  programId: 'acme',
  name: '2026-01-01-xss.md',
  path: 'C:/data/reports/acme/2026-01-01-xss.md',
  size: 512,
  updatedAt: Date.UTC(2026, 0, 1),
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.reports.list.mockResolvedValue({ ok: true, reports: [report()] })
  api.reports.open.mockResolvedValue({ ok: true })
  api.reports.reveal.mockResolvedValue({ ok: true })
})

describe('ReportsScreen', () => {
  it('affiche les rapports avec programme et taille', async () => {
    render(<ReportsScreen />)

    expect(await screen.findByText('2026-01-01-xss.md')).toBeTruthy()
    expect(screen.getByText('acme')).toBeTruthy()
    expect(screen.getByText('512 o')).toBeTruthy()
    expect(screen.getByText('1 / 1 rapport')).toBeTruthy()
  })

  it('invite a produire un rapport quand il n y en a aucun', async () => {
    api.reports.list.mockResolvedValue({ ok: true, reports: [] })
    render(<ReportsScreen />)

    expect(await screen.findByText(/Aucun rapport pour l’instant/)).toBeTruthy()
  })

  it('filtre par fichier ou programme', async () => {
    api.reports.list.mockResolvedValue({
      ok: true,
      reports: [report(), report({ programId: 'beta', name: 'csrf.md', path: 'C:/data/reports/beta/csrf.md' })],
    })
    render(<ReportsScreen />)
    await screen.findByText('csrf.md')

    fireEvent.change(screen.getByLabelText('Rechercher un rapport'), { target: { value: 'csr' } })

    expect(screen.getByText('csrf.md')).toBeTruthy()
    expect(screen.queryByText('2026-01-01-xss.md')).toBeNull()
    expect(screen.getByText('1 / 2 rapports')).toBeTruthy()
  })

  it('signale un filtre sans resultat', async () => {
    render(<ReportsScreen />)
    await screen.findByText('2026-01-01-xss.md')

    fireEvent.change(screen.getByLabelText('Rechercher un rapport'), { target: { value: 'zzz' } })

    expect(screen.getByText('Aucun rapport ne correspond au filtre.')).toBeTruthy()
  })

  it('ouvre le rapport via le pont', async () => {
    render(<ReportsScreen />)

    fireEvent.click(await screen.findByText('Ouvrir'))

    expect(api.reports.open).toHaveBeenCalledWith('acme', '2026-01-01-xss.md')
  })

  it('signale un echec d ouverture', async () => {
    api.reports.open.mockResolvedValue({ ok: false, error: 'fichier absent' })
    render(<ReportsScreen />)

    fireEvent.click(await screen.findByText('Ouvrir'))

    expect(await screen.findByText('Ouverture impossible : fichier absent')).toBeTruthy()
  })

  it('revele le dossier du rapport', async () => {
    render(<ReportsScreen />)

    fireEvent.click(await screen.findByText('Dossier'))

    expect(api.reports.reveal).toHaveBeenCalledWith('acme', '2026-01-01-xss.md')
  })

  it('signale un echec de chargement', async () => {
    api.reports.list.mockRejectedValue(new Error('pont IPC coupe'))
    render(<ReportsScreen />)

    expect(await screen.findByText('Impossible de charger les rapports : pont IPC coupe')).toBeTruthy()
  })

  it('rafraichit la liste', async () => {
    render(<ReportsScreen />)
    await screen.findByText('2026-01-01-xss.md')

    fireEvent.click(screen.getByText('Rafraîchir'))

    await waitFor(() => expect(api.reports.list).toHaveBeenCalledTimes(2))
  })
})
