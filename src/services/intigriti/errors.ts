export class BountyDeskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

export class ApiError extends BountyDeskError {}

export class AuthError extends ApiError {}

export class RateLimitError extends ApiError {
  constructor(readonly retryAfterMs: number | null = null, message = 'Trop de requêtes.') {
    super(message)
  }
}

export class RetryableError extends ApiError {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export class NetworkError extends BountyDeskError {}

export function isRetryable(error: unknown): boolean {
  return error instanceof RetryableError || error instanceof RateLimitError || error instanceof NetworkError
}