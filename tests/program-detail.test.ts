// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

let repoImpl: any

vi.mock('../src/main/db', () => ({
  getRepository: () => repoImpl
}))

import { fetchProgramDetail, getCachedProgramDetail } from '../src/main/services/program-detail'
import type { Domain, ProgramDetail, ProgramDomains, ProgramRules, RulesVersion } from '../src/services/intigriti/schema'

type Client = Parameters<typeof fetchProgramDetail>[0]

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function en(value: string, id = 1) {
  return { id, value }
}

function domain(over: Partial<Domain> = {}): Domain {
  return {
    id: U(2),
    type: en('URL', 1),
    endpoint: 'https://app.acme.com',
    tier: en('Tier 1', 4),
    description: '',
    requiredSkills: [],
    ...over
  }
}

function detail(over: Partial<ProgramDetail> = {}): ProgramDetail {
  return {
    id: U(1),
    handle: 'acme',
    name: 'Acme',
    following: false,
    confidentialityLevel: en('public'),
    status: en('open'),
    type: en('bug-bounty'),
    domains: { id: U(3), createdAt: 1, content: [] },
    rulesOfEngagement: null,
    webLinks: { detail: 'https://app.intigriti.com/programs/acme' },
    industry: 'tech',
    ...over
  }
}

function roeVersion(content: RulesVersion['content'], attachments: RulesVersion['attachments'] = []): RulesVersion {
  return { id: U(4), createdAt: 1, content, attachments }
}

function makeClient(over: Partial<Client> = {}): Client {
  return {
    getProgram: async () => detail(),
    getProgramDomains: async (): Promise<ProgramDomains> => ({ domains: { id: U(3), createdAt: 1, content: [] } }),
    getProgramRules: async (): Promise<ProgramRules> => ({ rulesOfEngagement: roeVersion(null) }),
    ...over
  } as Client
}

function makeRepo(over: Record<string, unknown> = {}) {
  return {
    getProgram: () => null,
    setProgramDetail: vi.fn(),
    getProgramDetail: () => null,
    ...over
  }
}

beforeEach(() => {
  repoImpl = makeRepo()
})

describe('fetchProgramDetail', () => {
  it('marque hors scope uniquement les domaines dont le tier est "Out of scope"', async () => {
    const c = makeClient({
      getProgramDomains: async () => ({
        domains: {
          id: U(3),
          createdAt: 1,
          content: [
            domain({ id: U(10), type: en('URL', 1), tier: en('Tier 1', 4), endpoint: 'https://a.acme.com' }),
            domain({ id: U(11), type: en('Wildcard', 7), tier: en('Out of scope', 5), endpoint: '*.acme.com' }),
            domain({ id: U(12), type: en('IP range', 4), tier: en('No bounty', 1), endpoint: '10.0.0.0/24' })
          ]
        }
      })
    })
    const res = await fetchProgramDetail(c, U(1))
    expect(res.scope.map((s) => s.inScope)).toEqual([true, false, true])
    expect(res.scope[0]).toMatchObject({ endpoint: 'https://a.acme.com', type: 'URL', tier: 'Tier 1', inScope: true })
    expect(res.scope[1]).toMatchObject({ endpoint: '*.acme.com', type: 'Wildcard', inScope: false })
  })

  it('ne depend pas du type d actif (URL/Wildcard sont in-scope)', async () => {
    const c = makeClient({
      getProgramDomains: async () => ({
        domains: { id: U(3), createdAt: 1, content: [domain({ type: en('URL', 1), tier: en('Tier 2', 3) })] }
      })
    })
    const res = await fetchProgramDetail(c, U(1))
    expect(res.scope[0]?.inScope).toBe(true)
  })

  it('persiste le scope et le roe via setProgramDetail', async () => {
    repoImpl = makeRepo({ getProgram: () => ({ webLink: null }) })
    const setProgramDetail = repoImpl.setProgramDetail as ReturnType<typeof vi.fn>
    const c = makeClient({
      getProgramDomains: async () => ({
        domains: { id: U(3), createdAt: 1, content: [domain({ endpoint: 'https://a.acme.com' })] }
      }),
      getProgramRules: async () => ({
        rulesOfEngagement: roeVersion({
          description: 'règles',
          testingRequirements: { intigritiMe: true },
          safeHarbour: true
        })
      })
    })
    const res = await fetchProgramDetail(c, U(1))
    expect(setProgramDetail).toHaveBeenCalledTimes(1)
    const [programId, scopeJson, roeJson, fetchedAt] = setProgramDetail.mock.calls[0]!
    expect(programId).toBe(U(1))
    expect(JSON.parse(scopeJson as string)).toEqual(res.scope)
    expect(JSON.parse(roeJson as string)).toEqual(res.roe)
    expect(typeof fetchedAt).toBe('number')
  })

  it('roe null et pas d appel getProgramRules quand rulesOfEngagement est absent', async () => {
    const getProgramRules = vi.fn()
    const c = makeClient({ getProgram: async () => detail({ rulesOfEngagement: null }), getProgramRules })
    const res = await fetchProgramDetail(c, U(1))
    expect(res.roe).toBeNull()
    expect(getProgramRules).not.toHaveBeenCalled()
  })

  it('mappe les champs du rules of engagement', async () => {
    const c = makeClient({
      getProgram: async () => detail({ rulesOfEngagement: roeVersion(null) }),
      getProgramRules: async () => ({
        rulesOfEngagement: roeVersion(
          {
            description: 'desc',
            testingRequirements: {
              intigritiMe: true,
              automatedTooling: 2,
              userAgent: 'UA',
              requestHeader: 'X'
            },
            safeHarbour: true
          },
          [{ url: 'https://a', code: 1 }]
        )
      })
    })
    const res = await fetchProgramDetail(c, U(1))
    expect(res.roe).toEqual({
      description: 'desc',
      intigritiMe: true,
      automatedTooling: 2,
      userAgent: 'UA',
      requestHeader: 'X',
      safeHarbour: true,
      attachments: [{ url: 'https://a', code: 1 }]
    })
  })

  it('roe: content null -> valeurs par defaut, attachments conserves', async () => {
    const c = makeClient({
      getProgram: async () => detail({ rulesOfEngagement: roeVersion(null, [{ url: 'https://b', code: 2 }]) }),
      getProgramRules: async () => ({ rulesOfEngagement: roeVersion(null, [{ url: 'https://b', code: 2 }]) })
    })
    const res = await fetchProgramDetail(c, U(1))
    expect(res.roe).toEqual({
      description: '',
      intigritiMe: false,
      automatedTooling: null,
      userAgent: null,
      requestHeader: null,
      safeHarbour: false,
      attachments: [{ url: 'https://b', code: 2 }]
    })
  })

  it('retombe sur le webLink de la ligne programme', async () => {
    repoImpl = makeRepo({ getProgram: () => ({ webLink: 'https://app.intigriti.com/programs/row' }) })
    const c = makeClient({ getProgram: async () => detail({ webLinks: undefined as unknown as ProgramDetail['webLinks'] }) })
    const res = await fetchProgramDetail(c, U(1))
    expect(res.webLink).toBe('https://app.intigriti.com/programs/row')
  })
})

describe('getCachedProgramDetail', () => {
  it('renvoie null si le detail n a pas ete mis en cache', () => {
    repoImpl = makeRepo({ getProgram: () => ({ handle: 'acme' }), getProgramDetail: () => null })
    expect(getCachedProgramDetail(U(1))).toBeNull()
  })

  it('renvoie null si le programme n existe pas', () => {
    repoImpl = makeRepo({
      getProgram: () => null,
      getProgramDetail: () => ({ scopeJson: '[]', roeJson: null, fetchedAt: 5 })
    })
    expect(getCachedProgramDetail(U(1))).toBeNull()
  })

  it('reconstruit scope/roe depuis le JSON en cache', () => {
    const scope = [domain({ type: en('URL', 1), tier: en('Tier 1', 4) })]
    repoImpl = makeRepo({
      getProgram: () => ({
        handle: 'acme',
        name: 'Acme',
        status: 'open',
        type: 'bug-bounty',
        confidentiality: 'public',
        industry: 'tech',
        webLink: 'https://w',
        minBounty: { value: 1, currency: 'EUR' },
        maxBounty: { value: 2, currency: 'EUR' }
      }),
      getProgramDetail: () => ({ scopeJson: JSON.stringify(scope), roeJson: null, fetchedAt: 42 })
    })
    const res = getCachedProgramDetail(U(1))
    expect(res?.scope).toEqual(scope)
    expect(res?.roe).toBeNull()
    expect(res?.fetchedAt).toBe(42)
  })

  it('renvoie null si le JSON en cache est corrompu', () => {
    repoImpl = makeRepo({
      getProgram: () => ({ handle: 'acme' }),
      getProgramDetail: () => ({ scopeJson: '{oops', roeJson: null, fetchedAt: 1 })
    })
    expect(getCachedProgramDetail(U(1))).toBeNull()
  })
})
