import { describe, expect, it, vi, type Mock } from 'vitest'
import { IntigritiClient } from '../src/services/intigriti/client'
import { Throttler } from '../src/services/intigriti/throttler'
import { AuthError, NetworkError } from '../src/services/intigriti/errors'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function makeClient(
  fetchMock: Mock,
  options: { token?: string; maxRetries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): IntigritiClient {
  const throttler = new Throttler({ capacity: 1000, refillPerInterval: 1000, refillIntervalMs: 1, now: () => 0 })
  return new IntigritiClient({
    throttler,
    token: options.token ?? '0'.repeat(40),
    fetchImpl: fetchMock as unknown as typeof fetch,
    maxRetries: options.maxRetries ?? 4,
    baseDelayMs: options.baseDelayMs ?? 500,
    rand: () => 0,
    sleep: options.sleep ?? (async () => undefined)
  })
}

function validOverviewPage(): unknown {
  return {
    maxCount: 2,
    records: [
      {
        id: 'a4d1a933-cf5f-4e2d-ae8f-5b5e6f6a9d01',
        name: 'ACME',
        handle: 'acme',
        following: true,
        minBounty: { value: 250, currency: 'EUR' },
        maxBounty: { value: 5000, currency: 'EUR' },
        confidentialityLevel: { id: 3, value: 'public' },
        status: { id: 1, value: 'active' },
        type: { id: 1, value: 'web' },
        webLinks: { detail: 'https://intigriti.com/programs/acme' },
        industry: null
      }
    ]
  }
}

const PROGRAM_DETAIL_ID = 'a4d1a933-cf5f-4e2d-ae8f-5b5e6f6a9d01'

function validProgramDetail(): unknown {
  return {
    id: PROGRAM_DETAIL_ID,
    handle: 'acme',
    name: 'ACME',
    following: true,
    confidentialityLevel: { id: 3, value: 'public' },
    status: { id: 1, value: 'active' },
    type: { id: 1, value: 'web' },
    domains: { id: PROGRAM_DETAIL_ID, createdAt: 0, content: [] },
    rulesOfEngagement: null,
    webLinks: { detail: 'https://intigriti.com/programs/acme' }
  }
}

describe('IntigritiClient', () => {
  it('encode les identifiants dans le chemin (anti-injection)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(validProgramDetail()))
    const client = makeClient(fetchMock)
    await client.getProgram('a/b c?d')
    const call = fetchMock.mock.calls[0] as unknown as [string]
    expect(call[0]).toContain('/v1/programs/a%2Fb%20c%3Fd')
    expect(call[0]).not.toContain('a/b c?d')
  })

  it('envoie le bearer token et parse une page valide', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(validOverviewPage()))
    const client = makeClient(fetchMock, { token: 'tok123' })
    const page = await client.listPrograms({ limit: 100 })
    expect(page.maxCount).toBe(2)
    expect(page.records[0]?.handle).toBe('acme')
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toContain('/v1/programs')
    expect((call[1].headers as Record<string, string>).Authorization).toBe('Bearer tok123')
  })

  it('retire les params undefined de la query', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(validOverviewPage()))
    const client = makeClient(fetchMock)
    await client.listPrograms({ following: true, offset: 0 })
    const call = fetchMock.mock.calls[0] as unknown as [string]
    expect(call[0]).toContain('following=true')
    expect(call[0]).toContain('offset=0')
    expect(call[0]).not.toContain('statusId')
  })

  it('transmet le retry-after du 429 puis réussit', async () => {
    const sleeps: number[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse(validOverviewPage()))
    const client = makeClient(fetchMock, {
      sleep: async (ms) => {
        sleeps.push(ms)
      }
    })
    const page = await client.listPrograms({ limit: 100 })
    expect(page.maxCount).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleeps).toEqual([2000])
  })

  it('n’abuse pas du retry-after (borné à 5 min)', async () => {
    const sleeps: number[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '36000' }))
      .mockResolvedValueOnce(jsonResponse(validOverviewPage()))
    const client = makeClient(fetchMock, {
      sleep: async (ms) => {
        sleeps.push(ms)
      }
    })
    await client.listPrograms({ limit: 100 })
    expect(sleeps).toEqual([300_000])
  })

  it('applique un backoff exponentiel borné sur erreur 5xx', async () => {
    const sleeps: number[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({}, 500))
    const client = makeClient(fetchMock, {
      maxRetries: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      }
    })
    await expect(client.listPrograms({ limit: 100 })).rejects.toBeInstanceOf(Error)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(sleeps).toEqual([500, 1000, 2000])
  })

  it('ne retry jamais sur 401/403', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 401))
    const client = makeClient(fetchMock, { maxRetries: 5 })
    await expect(client.listPrograms({ limit: 100 })).rejects.toBeInstanceOf(AuthError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retry sur erreur réseau puis échoue au-delà du max', async () => {
    const sleeps: number[] = []
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const client = makeClient(fetchMock, {
      maxRetries: 2,
      sleep: async (ms) => {
        sleeps.push(ms)
      }
    })
    await expect(client.listPrograms({ limit: 100 })).rejects.toBeInstanceOf(NetworkError)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleeps.length).toBe(2)
  })

  it('lève une erreur d’auth si aucun token', async () => {
    const fetchMock = vi.fn()
    const client = new IntigritiClient({
      throttler: new Throttler({ capacity: 1000, refillPerInterval: 1000, refillIntervalMs: 1, now: () => 0 }),
      fetchImpl: fetchMock as unknown as typeof fetch
    })
    await expect(client.listPrograms({ limit: 100 })).rejects.toBeInstanceOf(AuthError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejette une réponse qui ne colle pas aux schémas', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ maxCount: 1, records: [{ id: 'nope' }] }))
    const client = makeClient(fetchMock)
    await expect(client.listPrograms({ limit: 100 })).rejects.toThrow('Schéma de réponse')
  })
})