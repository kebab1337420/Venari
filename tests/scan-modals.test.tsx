// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  ProgramDetailData,
  ProgramSummary,
  ScanEvent,
  ScanRecord,
  ScopeDomain,
} from '../src/shared/ipc'
import { Api } from '../src/renderer/src/api'
import { ScanProgressModal, ScanSetupModal } from '../src/renderer/src/components/ScanModals'

vi.mock('../src/renderer/src/api', () => ({
  Api: {
    scans: {
      list: vi.fn(),
      start: vi.fn(),
      events: vi.fn(),
      stop: vi.fn(),
    },
  },
}))

const list = vi.mocked(Api.scans.list)
const start = vi.mocked(Api.scans.start)
const events = vi.mocked(Api.scans.events)
const stop = vi.mocked(Api.scans.stop)

const program: ProgramSummary = {
  id: 'p1',
  handle: 'acme',
  name: 'Acme',
  type: null,
  status: null,
  confidentiality: null,
  minBounty: null,
  maxBounty: null,
  industry: null,
  webLink: null,
  following: true,
  favorite: false,
  note: '',
  tags: [],
  groups: [],
  updatedAt: 0,
}

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
    webLink: null,
    minBounty: null,
    maxBounty: null,
    scope: [domain('https://a.example.com')],
    roe: null,
    fetchedAt: 0,
    ...over,
  }
}

const scanRecord = (over: Partial<ScanRecord> = {}): ScanRecord => ({
  id: 7,
  programId: 'p1',
  depth: 'low',
  status: 'done',
  rateLimit: 1,
  roeConfirm: true,
  startedAt: 1_700_000_000_000,
  finishedAt: null,
  ...over,
})

const scanEvent = (seq: number, message: string): ScanEvent => ({
  seq,
  ts: 0,
  level: 'info',
  message,
})

const checkbox = (): HTMLInputElement => screen.getByRole('checkbox') as HTMLInputElement
const launchButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /Lancer le scan/ }) as HTMLButtonElement

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue({ ok: true, scans: [] })
  start.mockResolvedValue({ ok: true, scanId: 42 })
  events.mockResolvedValue({ ok: true, events: [], done: true })
  stop.mockResolvedValue({ ok: true })
})

afterEach(cleanup)

function renderSetup(over: { detail?: ProgramDetailData } = {}): {
  onStarted: ReturnType<typeof vi.fn>
  onViewLog: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const onStarted = vi.fn()
  const onViewLog = vi.fn()
  const onClose = vi.fn()
  render(
    <ScanSetupModal
      program={program}
      detail={over.detail ?? detail()}
      onClose={onClose}
      onStarted={onStarted}
      onViewLog={onViewLog}
    />,
  )
  return { onStarted, onViewLog, onClose }
}

describe('ScanSetupModal', () => {
  it('liste les scans precedents du programme', async () => {
    list.mockResolvedValue({ ok: true, scans: [scanRecord({ id: 7 })] })
    const { onViewLog } = renderSetup()
    const item = await screen.findByText(/#7/)
    expect(list).toHaveBeenCalledWith('p1')
    fireEvent.click(item)
    expect(onViewLog).toHaveBeenCalledWith(7)
  })

  it('compte uniquement les cibles web in-scope', () => {
    renderSetup({
      detail: detail({
        scope: [domain('https://a.example.com'), domain('ftp://files.example.com'), domain('https://b.example.com', false)],
      }),
    })
    expect(screen.getByText('Cibles in-scope (1)')).toBeTruthy()
  })

  it('desactive le lancement sans cible exploitable', () => {
    renderSetup({ detail: detail({ scope: [domain('ftp://files.example.com')] }) })
    expect(screen.getByText('Aucune cible web in-scope. Scan impossible.')).toBeTruthy()
    fireEvent.click(checkbox())
    expect(launchButton().disabled).toBe(true)
  })

  it('garde le lancement desactive tant que le ROCE n est pas confirme', () => {
    renderSetup()
    expect(launchButton().disabled).toBe(true)
    fireEvent.click(checkbox())
    expect(launchButton().disabled).toBe(false)
  })

  it('lance le scan en profondeur basse apres confirmation', async () => {
    const { onStarted } = renderSetup()
    fireEvent.click(checkbox())
    fireEvent.click(launchButton())

    await waitFor(() => expect(start).toHaveBeenCalledWith('p1', { depth: 'low', roeConfirm: true }))
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(42))
  })

  it('transmet la profondeur choisie', async () => {
    renderSetup()
    fireEvent.click(screen.getByText('Moyen'))
    expect(launchButton().textContent).toContain('med')
    fireEvent.click(checkbox())
    fireEvent.click(launchButton())
    await waitFor(() => expect(start).toHaveBeenCalledWith('p1', { depth: 'med', roeConfirm: true }))
  })

  it('affiche l erreur de lancement sans ouvrir le journal', async () => {
    start.mockResolvedValue({ ok: false, error: 'scope expire' })
    const { onStarted } = renderSetup()
    fireEvent.click(checkbox())
    fireEvent.click(launchButton())
    expect(await screen.findByText('scope expire')).toBeTruthy()
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('affiche les regles d engagement quand elles existent', () => {
    renderSetup({
      detail: detail({
        roe: {
          description: 'Testez uniquement le staging.',
          intigritiMe: true,
          automatedTooling: 1,
          userAgent: 'bountydesk/1.0',
          requestHeader: 'X-Test: 1',
          safeHarbour: true,
          attachments: [],
        },
      }),
    })
    expect(screen.getByText('Testez uniquement le staging.')).toBeTruthy()
    expect(screen.getByText(/Outils auto : 1/)).toBeTruthy()
    expect(screen.getByText('bountydesk/1.0')).toBeTruthy()
  })

  it('signale l absence de regles d engagement', () => {
    renderSetup()
    expect(screen.getByText('Aucune règle d’engagement disponible pour ce programme.')).toBeTruthy()
  })
})

describe('ScanProgressModal', () => {
  it('affiche les evenements recus', async () => {
    events.mockResolvedValue({ ok: true, events: [scanEvent(1, 'demarrage')], done: false })
    render(<ScanProgressModal program={program} scanId={7} onClose={vi.fn()} />)
    expect(await screen.findByText('demarrage')).toBeTruthy()
    expect(events).toHaveBeenCalledWith(7, 0)
  })

  it('passe au titre termine et masque le bouton arreter', async () => {
    events.mockResolvedValue({ ok: true, events: [scanEvent(1, 'fin')], done: true })
    render(<ScanProgressModal program={program} scanId={7} onClose={vi.fn()} />)
    expect(await screen.findByText(/scan terminé/)).toBeTruthy()
    expect(screen.getByRole('dialog', { name: /Scan terminé/ })).toBeTruthy()
    expect(screen.queryByText('■ Arrêter')).toBeNull()
  })

  it('affiche l erreur de suivi', async () => {
    events.mockResolvedValue({ ok: false, error: 'scan introuvable' })
    render(<ScanProgressModal program={program} scanId={7} onClose={vi.fn()} />)
    expect(await screen.findByText('scan introuvable')).toBeTruthy()
  })

  it('arrete le scan a la demande', async () => {
    events.mockResolvedValue({ ok: true, events: [], done: false })
    render(<ScanProgressModal program={program} scanId={7} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('■ Arrêter'))
    await waitFor(() => expect(stop).toHaveBeenCalledWith(7))
  })

  it('ferme via le bouton Fermer', async () => {
    const onClose = vi.fn()
    events.mockResolvedValue({ ok: true, events: [], done: true })
    render(<ScanProgressModal program={program} scanId={7} onClose={onClose} />)
    fireEvent.click(await screen.findByText('Fermer'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
