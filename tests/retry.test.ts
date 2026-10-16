import { describe, expect, it, vi } from 'vitest'
import { withRetry } from '../src/services/intigriti/retry'
import { ApiError, AuthError, NetworkError, RateLimitError, RetryableError } from '../src/services/intigriti/errors'

function recordingSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms)
    }
  }
}

describe('withRetry (politique de reprise des appels Intigriti)', () => {
  it('renvoie le resultat sans dormir quand fn reussit du premier coup', async () => {
    const { delays, sleep } = recordingSleep()
    const fn = vi.fn().mockResolvedValue(42)
    await expect(withRetry(fn, { sleep })).resolves.toBe(42)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
  })

  it('retente une NetworkError puis renvoie le resultat', async () => {
    const { delays, sleep } = recordingSleep()
    const fn = vi.fn().mockRejectedValueOnce(new NetworkError('coupure')).mockResolvedValue('ok')
    await expect(withRetry(fn, { baseDelayMs: 10, rand: () => 0, sleep })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([10])
  })

  it('retente un RetryableError maxRetries fois puis propage', async () => {
    const { delays, sleep } = recordingSleep()
    const fn = vi.fn().mockRejectedValue(new RetryableError(503, 'indispo'))
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 10, rand: () => 0, sleep })).rejects.toBeInstanceOf(
      RetryableError
    )
    expect(fn).toHaveBeenCalledTimes(3)
    expect(delays).toHaveLength(2)
  })

  it('ne retente pas une AuthError', async () => {
    const { delays, sleep } = recordingSleep()
    const fn = vi.fn().mockRejectedValue(new AuthError('acces refuse'))
    await expect(withRetry(fn, { sleep })).rejects.toBeInstanceOf(AuthError)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
  })

  it('ne retente pas une ApiError non transitoire', async () => {
    const { delays, sleep } = recordingSleep()
    const fn = vi.fn().mockRejectedValue(new ApiError('reponse inattendue'))
    await expect(withRetry(fn, { sleep })).rejects.toBeInstanceOf(ApiError)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
  })

  it('respecte retryAfterMs quand Retry-After est fourni', async () => {
    const { delays, sleep } = recordingSleep()
    const fn = vi.fn().mockRejectedValueOnce(new RateLimitError(5000)).mockResolvedValue('ok')
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok')
    expect(delays).toEqual([5000])
  })

  it('impose un plancher de 1 s quand Retry-After vaut 0', async () => {
    const { delays, sleep } = recordingSleep()
    const fn = vi.fn().mockRejectedValueOnce(new RateLimitError(0)).mockResolvedValue('ok')
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok')
    expect(delays).toEqual([1000])
  })

  it('applique le backoff exponentiel avec un jitter borne a 30 %', async () => {
    const { delays, sleep } = recordingSleep()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError('x'))
      .mockRejectedValueOnce(new NetworkError('x'))
      .mockResolvedValue('ok')
    // rand = 1 -> jitter maximal : 130 % du backoff (100 -> 130, 200 -> 260).
    await expect(withRetry(fn, { baseDelayMs: 100, rand: () => 1, sleep })).resolves.toBe('ok')
    expect(delays).toEqual([130, 260])
  })

  it('plafonne le delai a maxDelayMs', async () => {
    const { delays, sleep } = recordingSleep()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError(500, 'x'))
      .mockRejectedValueOnce(new RetryableError(500, 'x'))
      .mockResolvedValue('ok')
    // backoff 1000 puis 2000, plafonne a 1500.
    await expect(withRetry(fn, { baseDelayMs: 1000, maxDelayMs: 1500, rand: () => 0, sleep })).resolves.toBe('ok')
    expect(delays).toEqual([1000, 1500])
  })
})
