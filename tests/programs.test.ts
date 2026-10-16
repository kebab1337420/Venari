import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProgramOverview } from '../src/services/intigriti/schema'
import type { IntigritiClient } from '../src/services/intigriti'

const paginateMock = vi.fn()
const upsertPrograms = vi.fn()

vi.mock('../src/services/intigriti', () => ({
  paginate: (...args: unknown[]) => paginateMock(...args),
}))

vi.mock('../src/main/db', () => ({
  getRepository: () => ({ upsertPrograms }),
}))

import { syncPrograms, toProgramInput } from '../src/main/services/programs'

function overview(overrides: Partial<ProgramOverview> = {}): ProgramOverview {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    handle: 'acme',
    name: 'Acme Corp',
    following: true,
    minBounty: { value: 100, currency: 'EUR' },
    maxBounty: { value: 5000, currency: 'USD' },
    confidentialityLevel: { id: 1, value: 'public' },
    status: { id: 2, value: 'active' },
    type: { id: 3, value: 'bug_bounty' },
    webLinks: { detail: 'https://acme.example' },
    industry: 'Software',
    ...overrides,
  } as ProgramOverview
}

beforeEach(() => {
  paginateMock.mockReset()
  upsertPrograms.mockReset()
})

describe('toProgramInput', () => {
  it('mappe tous les champs et conserve le JSON brut', () => {
    const p = overview()
    expect(toProgramInput(p)).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      handle: 'acme',
      name: 'Acme Corp',
      type: 'bug_bounty',
      status: 'active',
      confidentiality: 'public',
      minBounty: { value: 100, currency: 'EUR' },
      maxBounty: { value: 5000, currency: 'USD' },
      industry: 'Software',
      webLink: 'https://acme.example',
      following: true,
      rawJson: JSON.stringify(p),
    })
  })

  it('rend les primes nulles quand la valeur est nulle ou absente', () => {
    const nul = overview({
      minBounty: { value: null, currency: 'EUR' } as unknown as ProgramOverview['minBounty'],
      maxBounty: null,
    })
    expect(toProgramInput(nul).minBounty).toBeNull()
    expect(toProgramInput(nul).maxBounty).toBeNull()

    const absent = overview({ minBounty: undefined, maxBounty: undefined })
    expect(toProgramInput(absent).minBounty).toBeNull()
    expect(toProgramInput(absent).maxBounty).toBeNull()
  })

  it('rend null pour les champs optionnels absents', () => {
    const p = overview({
      industry: undefined,
      webLinks: undefined as unknown as ProgramOverview['webLinks'],
    })
    const input = toProgramInput(p)
    expect(input.industry).toBeNull()
    expect(input.webLink).toBeNull()
  })
})

describe('syncPrograms', () => {
  it('insere les programmes pagines et renvoie le nombre', async () => {
    paginateMock.mockResolvedValue([overview({ handle: 'a' }), overview({ handle: 'b' })])
    const client = { listPrograms: vi.fn() } as unknown as IntigritiClient

    const count = await syncPrograms(client)

    expect(count).toBe(2)
    expect(upsertPrograms).toHaveBeenCalledOnce()
    const rows = upsertPrograms.mock.calls[0]![0] as { handle: string }[]
    expect(rows.map((r) => r.handle)).toEqual(['a', 'b'])
  })

  it('ne demande que les programmes suivis quand followingOnly est vrai', async () => {
    let fetchPage: ((offset: number) => Promise<unknown>) | null = null
    paginateMock.mockImplementation(async (fn: (offset: number) => Promise<unknown>) => {
      fetchPage = fn
      return []
    })
    const listPrograms = vi.fn(async () => ({ content: [], pagination: {} }))
    const client = { listPrograms } as unknown as IntigritiClient

    await syncPrograms(client, true)
    expect(fetchPage).toBeTypeOf('function')
    await fetchPage!(0)

    expect(listPrograms).toHaveBeenCalledWith({ limit: 200, offset: 0, following: true })
  })

  it('omet le filtre following par defaut', async () => {
    let fetchPage: ((offset: number) => Promise<unknown>) | null = null
    paginateMock.mockImplementation(async (fn: (offset: number) => Promise<unknown>) => {
      fetchPage = fn
      return []
    })
    const listPrograms = vi.fn(async () => ({ content: [], pagination: {} }))
    const client = { listPrograms } as unknown as IntigritiClient

    await syncPrograms(client)
    await fetchPage!(200)

    expect(listPrograms).toHaveBeenCalledWith({ limit: 200, offset: 200, following: undefined })
  })
})
