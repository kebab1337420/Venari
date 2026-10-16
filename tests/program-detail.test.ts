import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntigritiClient } from '../src/services/intigriti'

interface FakeDetailRow {
  scopeJson: string | null
  roeJson: string | null
  fetchedAt: number
}

interface FakeProgramRow {
  handle: string
  name: string
  status: string | null
  type: string | null
  confidentiality: string | null
  industry: string | null
  webLink: string | null
  minBounty: { value: number; currency: string } | null
  maxBounty: { value: number; currency: string } | null
}

let repo: {
  programs: Map<string, FakeProgramRow>
  details: Map<string, FakeDetailRow>
  getProgram(id: string): FakeProgramRow | null
  getProgramDetail(id: string): FakeDetailRow | null
  setProgramDetail(id: string, scopeJson: string, roeJson: string | null, fetchedAt: number): void
}

vi.mock('../src/main/db', () => ({
  getRepository: () => repo,
}))

import { fetchProgramDetail, getCachedProgramDetail } from '../src/main/services/program-detail'

function programRow(overrides: Partial<FakeProgramRow> = {}): FakeProgramRow {
  return {
    handle: 'acme',
    name: 'Acme Corp',
    status: 'active',
    type: 'bug_bounty',
    confidentiality: 'public',
    industry: 'Software',
    webLink: 'https://row.example/acme',
    minBounty: { value: 50, currency: 'EUR' },
    maxBounty: { value: 5000, currency: 'EUR' },
    ...overrides,
  }
}

interface ClientStub {
  getProgram: ReturnType<typeof vi.fn>
  getProgramDomains: ReturnType<typeof vi.fn>
  getProgramRules: ReturnType<typeof vi.fn>
}

function clientStub(overrides: Partial<ClientStub> = {}): IntigritiClient {
  const stub: ClientStub = {
    getProgram: vi.fn(async () => ({
      handle: 'acme',
      name: 'Acme Corp',
      status: { value: 'active' },
      type: { value: 'bug_bounty' },
      confidentialityLevel: { value: 'public' },
      industry: 'Software',
      webLinks: { detail: 'https://detail.example/acme' },
      domains: { id: 'dom-1' },
      rulesOfEngagement: { id: 'roe-1' },
    })),
    getProgramDomains: vi.fn(async () => ({
      domains: {
        content: [
          {
            id: 'd1',
            type: { value: 'in-scope' },
            endpoint: 'api.acme.example',
            tier: { value: '1' },
            description: 'API publique',
          },
          {
            id: 'd2',
            type: { value: 'out-of-scope' },
            endpoint: 'admin.acme.example',
            tier: { value: '2' },
            description: 'Hors perimetre',
          },
        ],
      },
    })),
    getProgramRules: vi.fn(async () => ({
      rulesOfEngagement: {
        content: {
          description: 'Regles',
          testingRequirements: {
            intigritiMe: true,
            automatedTooling: false,
            userAgent: 'Venari-Test',
            requestHeader: 'X-Test: 1',
          },
          safeHarbour: true,
        },
        attachments: [{ name: 'roe.pdf', url: 'https://x/roe.pdf' }],
      },
    })),
    ...overrides,
  }
  return stub as unknown as IntigritiClient
}

beforeEach(() => {
  repo = {
    programs: new Map(),
    details: new Map(),
    getProgram(id) {
      return repo.programs.get(id) ?? null
    },
    getProgramDetail(id) {
      return repo.details.get(id) ?? null
    },
    setProgramDetail(id, scopeJson, roeJson, fetchedAt) {
      repo.details.set(id, { scopeJson, roeJson, fetchedAt })
    },
  }
})

describe('fetchProgramDetail', () => {
  it('mappe le programme, le scope et les regles, puis persiste le detail', async () => {
    repo.programs.set('p1', programRow())
    const client = clientStub()

    const before = Date.now()
    const data = await fetchProgramDetail(client, 'p1')

    expect(data.programId).toBe('p1')
    expect(data.handle).toBe('acme')
    expect(data.name).toBe('Acme Corp')
    expect(data.status).toBe('active')
    expect(data.type).toBe('bug_bounty')
    expect(data.confidentiality).toBe('public')
    expect(data.industry).toBe('Software')
    // webLink : celui du detail prime sur celui de la ligne locale.
    expect(data.webLink).toBe('https://detail.example/acme')
    // Bounty : repris de la ligne locale, pas de l'API.
    expect(data.minBounty).toEqual({ value: 50, currency: 'EUR' })
    expect(data.maxBounty).toEqual({ value: 5000, currency: 'EUR' })

    expect(data.scope).toEqual([
      {
        id: 'd1',
        type: 'in-scope',
        endpoint: 'api.acme.example',
        tier: '1',
        description: 'API publique',
        inScope: true,
      },
      {
        id: 'd2',
        type: 'out-of-scope',
        endpoint: 'admin.acme.example',
        tier: '2',
        description: 'Hors perimetre',
        inScope: false,
      },
    ])
    expect(data.roe).toEqual({
      description: 'Regles',
      intigritiMe: true,
      automatedTooling: false,
      userAgent: 'Venari-Test',
      requestHeader: 'X-Test: 1',
      safeHarbour: true,
      attachments: [{ name: 'roe.pdf', url: 'https://x/roe.pdf' }],
    })
    expect(data.fetchedAt).toBeGreaterThanOrEqual(before)

    const stored = repo.details.get('p1')
    expect(stored).toBeTruthy()
    expect(JSON.parse(stored!.scopeJson!)).toEqual(data.scope)
    expect(JSON.parse(stored!.roeJson!)).toEqual(data.roe)
  })

  it('retombe sur le webLink local et gere l\'absence de regles', async () => {
    repo.programs.set('p1', programRow({ webLink: 'https://row.example/acme' }))
    const client = clientStub({
      getProgram: vi.fn(async () => ({
        handle: 'acme',
        name: 'Acme Corp',
        status: { value: 'active' },
        type: { value: 'bug_bounty' },
        confidentialityLevel: { value: 'public' },
        industry: null,
        webLinks: {},
        domains: { id: 'dom-1' },
        rulesOfEngagement: null,
      })),
    })

    const data = await fetchProgramDetail(client, 'p1')
    expect(data.webLink).toBe('https://row.example/acme')
    expect(data.roe).toBeNull()
    expect(data.industry).toBeNull()
    expect(client.getProgramRules).not.toHaveBeenCalled()
    expect(repo.details.get('p1')!.roeJson).toBeNull()
  })

  it('applique les valeurs par defaut quand le contenu RoE est absent', async () => {
    repo.programs.set('p1', programRow())
    const client = clientStub({
      getProgramRules: vi.fn(async () => ({ rulesOfEngagement: {} })),
    })

    const data = await fetchProgramDetail(client, 'p1')
    expect(data.roe).toEqual({
      description: '',
      intigritiMe: false,
      automatedTooling: null,
      userAgent: null,
      requestHeader: null,
      safeHarbour: false,
      attachments: [],
    })
  })

  it('considere un scope vide si l\'API ne renvoie aucun domaine', async () => {
    repo.programs.set('p1', programRow())
    const client = clientStub({ getProgramDomains: vi.fn(async () => ({ domains: {} })) })
    expect((await fetchProgramDetail(client, 'p1')).scope).toEqual([])
  })

  it('detecte le perimetre sans tenir compte des tirets ni de la casse', async () => {
    repo.programs.set('p1', programRow())
    const client = clientStub({
      getProgramDomains: vi.fn(async () => ({
        domains: {
          content: [
            { id: 'a', type: { value: 'IN SCOPE' }, endpoint: 'a', tier: { value: '1' }, description: '' },
            { id: 'b', type: { value: 'inscope' }, endpoint: 'b', tier: { value: '1' }, description: '' },
            { id: 'c', type: { value: 'Out of scope' }, endpoint: 'c', tier: { value: '1' }, description: '' },
          ],
        },
      })),
    })
    const data = await fetchProgramDetail(client, 'p1')
    expect(data.scope.map((s) => [s.id, s.inScope])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
    ])
  })
})

describe('getCachedProgramDetail', () => {
  it('rend null sans detail en cache', () => {
    repo.programs.set('p1', programRow())
    expect(getCachedProgramDetail('p1')).toBeNull()
  })

  it('rend null si le programme n\'existe plus', () => {
    repo.details.set('p1', { scopeJson: '[]', roeJson: null, fetchedAt: 1 })
    expect(getCachedProgramDetail('p1')).toBeNull()
  })

  it('reconstruit le detail a partir du cache', () => {
    repo.programs.set('p1', programRow())
    const scope = [{ id: 'd1', type: 'in-scope', endpoint: 'x', tier: '1', description: '', inScope: true }]
    const roe = {
      description: 'r',
      intigritiMe: false,
      automatedTooling: null,
      userAgent: null,
      requestHeader: null,
      safeHarbour: false,
      attachments: [],
    }
    repo.details.set('p1', { scopeJson: JSON.stringify(scope), roeJson: JSON.stringify(roe), fetchedAt: 123 })

    const cached = getCachedProgramDetail('p1')
    expect(cached).toEqual({
      programId: 'p1',
      handle: 'acme',
      name: 'Acme Corp',
      status: 'active',
      type: 'bug_bounty',
      confidentiality: 'public',
      industry: 'Software',
      webLink: 'https://row.example/acme',
      minBounty: { value: 50, currency: 'EUR' },
      maxBounty: { value: 5000, currency: 'EUR' },
      scope,
      roe,
      fetchedAt: 123,
    })
  })

  it('rend null quand le JSON de scope est corrompu', () => {
    repo.programs.set('p1', programRow())
    repo.details.set('p1', { scopeJson: '{ pas du json', roeJson: null, fetchedAt: 1 })
    expect(getCachedProgramDetail('p1')).toBeNull()
  })
})
