// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ProgramDetailData, ProgramSummary } from '../src/shared/ipc'
import { Api } from '../src/renderer/src/api'
import { ProgramDetailModal } from '../src/renderer/src/components/ProgramDetailModal'

vi.mock('../src/renderer/src/api', () => ({
  Api: { programs: { detail: vi.fn() }, shell: { openExternal: vi.fn() } }
}))

// Les modals enfants ont leurs propres tests ; ici on ne verifie que le cablage.
vi.mock('../src/renderer/src/components/CredentialsModal', () => ({
  CredentialsModal: () => <div>CREDS-SCREEN</div>
}))
vi.mock('../src/renderer/src/components/ScanModals', () => ({
  ScanSetupModal: () => <div>SCAN-SETUP</div>,
  ScanProgressModal: () => <div>SCAN-PROGRESS</div>
}))

afterEach(cleanup)

const detail = vi.mocked(Api.programs.detail)
const openExternal = vi.mocked(Api.shell.openExternal)

function program(overrides: Partial<ProgramSummary> = {}): ProgramSummary {
  return {
    id: 'p1',
    handle: 'acme-h',
    name: 'Acme Corp',
    type: null,
    status: null,
    confidentiality: null,
    minBounty: null,
    maxBounty: null,
    industry: null,
    webLink: null,
    following: false,
    favorite: false,
    note: '',
    tags: [],
    groups: [],
    updatedAt: 0,
    ...overrides
  }
}

function detailData(overrides: Partial<ProgramDetailData> = {}): ProgramDetailData {
  return {
    programId: 'p1',
    handle: 'acme-h',
    name: 'Acme Corp',
    status: null,
    type: null,
    confidentiality: null,
    industry: null,
    webLink: null,
    minBounty: null,
    maxBounty: null,
    scope: [],
    roe: null,
    fetchedAt: 0,
    ...overrides
  }
}

function renderModal(p: ProgramSummary = program()): void {
  render(<ProgramDetailModal program={p} onClose={vi.fn()} />)
}

describe('ProgramDetailModal', () => {
  it('affiche un indicateur de chargement puis le detail', async () => {
    detail.mockResolvedValue({ ok: true, detail: detailData({ status: 'open', type: 'web' }) })
    renderModal()
    expect(screen.getByText('Chargement du détail…')).toBeTruthy()
    expect(await screen.findByText('acme-h')).toBeTruthy()
    expect(screen.getByText('open')).toBeTruthy()
    expect(screen.getByText('web')).toBeTruthy()
    expect(screen.queryByText('Chargement du détail…')).toBeNull()
  })

  it('compte uniquement les cibles in-scope (le tier decide, cf. correctif #29)', async () => {
    detail.mockResolvedValue({
      ok: true,
      detail: detailData({
        scope: [
          { id: '1', type: 'URL', endpoint: 'https://a.example.com', tier: 'Tier 1', description: '', inScope: true },
          { id: '2', type: 'Wildcard', endpoint: '*.example.com', tier: 'Tier 2', description: '', inScope: true },
          { id: '3', type: 'URL', endpoint: 'https://old.example.com', tier: 'Out of scope', description: '', inScope: false }
        ]
      })
    })
    renderModal()
    expect(await screen.findByText('2 / 3 cibles')).toBeTruthy()
    expect(screen.getAllByText('IN')).toHaveLength(2)
    expect(screen.getByText('OUT')).toBeTruthy()
  })

  it('affiche le message d erreur quand le detail echoue', async () => {
    detail.mockResolvedValue({ ok: false, error: 'Aucun token configuré ni cache disponible' })
    renderModal()
    expect(await screen.findByText('Aucun token configuré ni cache disponible')).toBeTruthy()
    expect(screen.queryByText('Chargement du détail…')).toBeNull()
  })

  it('sort du chargement quand l appel IPC rejette', async () => {
    detail.mockRejectedValue(new Error('pont IPC coupe'))
    renderModal()
    expect(await screen.findByText('Détail du programme indisponible.')).toBeTruthy()
    expect(screen.queryByText('Chargement du détail…')).toBeNull()
  })

  it('signale un scope vide', async () => {
    detail.mockResolvedValue({ ok: true, detail: detailData() })
    renderModal()
    expect(await screen.findByText('Aucun domaine renseigné.')).toBeTruthy()
    expect(screen.getByText('0 / 0 cibles')).toBeTruthy()
  })

  it('ouvre le lien du programme via le pont', async () => {
    detail.mockResolvedValue({ ok: true, detail: detailData({ webLink: 'https://app.intigriti.com/acme' }) })
    renderModal()
    fireEvent.click(await screen.findByText('Ouvrir la page du programme'))
    expect(openExternal).toHaveBeenCalledWith('https://app.intigriti.com/acme')
  })

  it('affiche les drapeaux ROE, l UA, l en-tete et les pieces jointes', async () => {
    detail.mockResolvedValue({
      ok: true,
      detail: detailData({
        roe: {
          description: 'Règles strictes',
          intigritiMe: true,
          automatedTooling: 0,
          userAgent: 'Venari/1.0',
          requestHeader: 'X-Bug-Bounty: acme',
          safeHarbour: true,
          attachments: [{ url: 'https://x/a.pdf', code: 1 }]
        }
      })
    })
    renderModal()
    expect(await screen.findByText('Règles d’engagement')).toBeTruthy()
    expect(screen.getByText('Règles strictes')).toBeTruthy()
    expect(screen.getByText('IntigritiMe ✓')).toBeTruthy()
    expect(screen.getByText('Outils auto : 0')).toBeTruthy()
    expect(screen.getByText('Venari/1.0')).toBeTruthy()
    expect(screen.getByText('X-Bug-Bounty: acme')).toBeTruthy()
    fireEvent.click(screen.getByText('Pièce jointe (1)'))
    expect(openExternal).toHaveBeenCalledWith('https://x/a.pdf')
  })

  it('ouvre le formulaire d identifiants', async () => {
    detail.mockResolvedValue({ ok: true, detail: detailData() })
    renderModal()
    fireEvent.click(await screen.findByText('Get credentials'))
    expect(screen.getByText('CREDS-SCREEN')).toBeTruthy()
  })

  it('ouvre la configuration de scan', async () => {
    detail.mockResolvedValue({ ok: true, detail: detailData() })
    renderModal()
    fireEvent.click(await screen.findByText('⚡ Scanner (low / med / high)'))
    expect(screen.getByText('SCAN-SETUP')).toBeTruthy()
  })
})
