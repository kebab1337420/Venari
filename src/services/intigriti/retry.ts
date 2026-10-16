import { AuthError, NetworkError, RateLimitError, RetryableError } from './errors'

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  rand?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 4
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 30_000
  const rand = options.rand ?? Math.random
  const sleep = options.sleep ?? defaultSleep

  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof AuthError || !isRetryable(error)) {
        throw error
      }
      if (attempt >= maxRetries) {
        throw error
      }
      let delayMs: number
      if (error instanceof RateLimitError && error.retryAfterMs !== null) {
        // Plancher d'une seconde : un `Retry-After: 0` ne doit pas provoquer une
        // boucle de requetes immediates.
        delayMs = Math.max(1000, error.retryAfterMs)
      } else {
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
        const jitter = rand() * 0.3 * backoff
        delayMs = Math.round(backoff + jitter)
      }
      attempt += 1
      await sleep(delayMs)
    }
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof RateLimitError || error instanceof RetryableError || error instanceof NetworkError
}