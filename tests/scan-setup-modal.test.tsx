// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ProgramDetailData, ProgramSummary, ScopeDomain } from '../src/shared/ipc'

const api = vi.hoisted(() => ({
  scans: { list: vi.fn(), start: vi.fn() },
}))

vi.mock('../src/renderer/src/api', () => ({ Api: api }))

import { ScanSetupModal } from '../src/renderer/src/components/ScanModals'

afterEach(cleanup)

const program: ProgramSummary = {
  id: 'p1',
  handle: 'acme',
  name: 'Acme Corp',
  type: 'bug-bounty',
  status: 'open',
  confidentiality: 'public',
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
}

const scope = (endpoint: string, over: Partial<ScopeDomain> = {}): ScopeDomain => ({
  id: endpoint,
  type: 'web',
  endpoint,
  tier: 'low',
  description: '',
  inScope: true,
  ...over,
})

const detail = (domains: ScopeDomain[]): ProgramDetailData => ({
  programId: 'p1',
  handle: 'acme',
  name: 'Acme Corp',
  status: 'open',
  type: 'bug-bounty',
  confidentiality: 'public',
  industry: null,
  webLink: null,
  minBounty: null,
  maxBounty: null,
  scope: domains,
  roe: null,
  fetchedAt: Date.now(),
})

const props = { program, onClose: vi.fn(), onStarted: vi.fn(), onViewLog: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  api.scans.list.mockResolvedValue({ ok: true, scans: [] })
})

describe('ScanSetupModal — cibles', () => {
  it('ignore un wildcard seul et empêche le lancement', async () => {
    render(<ScanSetupModal {...props} detail={detail([scope('*.example.com')])} />)

    expect(await screen.findByText(/Cibles in-scope \(0\)/)).toBeTruthy()
    expect(screen.getByText(/Aucune cible web in-scope/)).toBeTruthy()
    expect((screen.getByRole('button', { name: /Lancer le scan/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('ne liste que les cibles concrètes à côté des wildcards', async () => {
    render(
      <ScanSetupModal
        {...props}
        detail={detail([scope('*.api.example.com'), scope('app.example.com'), scope('exclu.example.com', { inScope: false })])}
      />
    )

    expect(await screen.findByText(/Cibles in-scope \(1\)/)).toBeTruthy()
    expect(screen.getByText('app.example.com')).toBeTruthy()
    expect(screen.queryByText('*.api.example.com')).toBeNull()
    expect(screen.queryByText('exclu.example.com')).toBeNull()
  })
})
