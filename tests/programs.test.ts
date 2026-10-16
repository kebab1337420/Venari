// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const upsertPrograms = vi.fn()
let repoImpl: unknown

vi.mock('../src/main/db', () => ({
  getRepository: () => repoImpl
}))

import { syncPrograms, toProgramInput } from '../src/main/services/programs'
import type { ProgramOverview } from '../src/services/intigriti/schema'

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const en = (value: string, id = 1) => ({ id, value })

function overview(over: Partial<ProgramOverview> = {}): ProgramOverview {
  return {
    id: U(1),
    handle: 'acme',
    name: 'Acme',
    following: false,
    confidentialityLevel: en('public'),
    status: en('open', 2),
    type: en('bug-bounty', 3),
    webLinks: { detail: 'https://app.intigriti.com/programs/acme' },
    ...over
  }
}

beforeEach(() => {
  upsertPrograms.mockReset()
  repoImpl = { upsertPrograms }
})

describe('toProgramInput', () => {
  it('mappe les champs d’un programme complet', () => {
    const row = toProgramInput(
      overview({
        minBounty: { value: 50, currency: 'EUR' },
        maxBounty: { value: 5000, currency: 'EUR' },
        industry: 'tech',
        following: true
      })
    )
    expect(row).toEqual({
      id: U(1),
      handle: 'acme',
      name: 'Acme',
      type: 'bug-bounty',
      status: 'open',
      confidentiality: 'public',
      minBounty: { value: 50, currency: 'EUR' },
      maxBounty: { value: 5000, currency: 'EUR' },
      industry: 'tech',
      webLink: 'https://app.intigriti.com/programs/acme',
      following: true,
      rawJson: null
    })
  })

  it('met les champs absents à null', () => {
    const row = toProgramInput(overview())
    expect(row.minBounty).toBeNull()
    expect(row.maxBounty).toBeNull()
    expect(row.industry).toBeNull()
  })

  it('met la bounty à null quand l’objet est explicitement null', () => {
    const row = toProgramInput(overview({ minBounty: null, maxBounty: null }))
    expect(row.minBounty).toBeNull()
    expect(row.maxBounty).toBeNull()
  })

  it('conserve une bounty de valeur 0', () => {
    const row = toProgramInput(overview({ minBounty: { value: 0, currency: 'USD' } }))
    expect(row.minBounty).toEqual({ value: 0, currency: 'USD' })
  })

  it('ne persiste jamais le blob brut de l’API', () => {
    expect(toProgramInput(overview()).rawJson).toBeNull()
  })
})

describe('syncPrograms', () => {
  function client(pages: Array<{ maxCount: number; records: ProgramOverview[] }>) {
    let i = 0
    return {
      listPrograms: vi.fn(async () => pages[i++] ?? { maxCount: 0, records: [] })
    }
  }

  it('agrège toutes les pages et persiste les lignes mappées', async () => {
    const c = client([
      { maxCount: 3, records: [overview({ id: U(1) }), overview({ id: U(2) })] },
      { maxCount: 3, records: [overview({ id: U(3) })] }
    ])
    const n = await syncPrograms(c as never)
    expect(n).toBe(3)
    expect(upsertPrograms).toHaveBeenCalledTimes(1)
    const rows = upsertPrograms.mock.calls[0]![0] as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual([U(1), U(2), U(3)])
  })

  it('passe following=true seulement quand followingOnly est demandé', async () => {
    const c = client([{ maxCount: 0, records: [] }])
    await syncPrograms(c as never, true)
    expect(c.listPrograms).toHaveBeenCalledWith(expect.objectContaining({ following: true }))
  })

  it('n’envoie pas following quand followingOnly est faux', async () => {
    const c = client([{ maxCount: 0, records: [] }])
    await syncPrograms(c as never)
    expect(c.listPrograms).toHaveBeenCalledWith(expect.objectContaining({ following: undefined }))
    expect(upsertPrograms).toHaveBeenCalledWith([])
  })
})
