import { z } from 'zod'
import { ApiError, AuthError, NetworkError, RateLimitError, RetryableError } from './errors'
import { withRetry, type RetryOptions } from './retry'
import { type Throttler } from './throttler'
import {
  programActivityPageSchema,
  programDetailSchema,
  programDomainsSchema,
  programOverviewPageSchema,
  programRulesSchema,
  type Page,
  type ProgramActivity,
  type ProgramDetail,
  type ProgramDomains,
  type ProgramOverview,
  type ProgramRules
} from './schema'
import pkg from '../../../package.json'

const DEFAULT_BASE_URL = 'https://api.intigriti.com/external/researcher'
const MAX_RETRY_AFTER_MS = 5 * 60_000

export const RATE_LIMIT = {
  capacity: 400,
  refillPerInterval: 400,
  refillIntervalMs: 300_000
} as const

export interface IntigritiClientOptions extends RetryOptions {
  baseUrl?: string
  token?: string
  throttler: Throttler
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface QueryParams {
  [key: string]: string | number | boolean | undefined | null
}

export class IntigritiClient {
  private readonly baseUrl: string
  private readonly throttler: Throttler
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly retryOptions: RetryOptions
  private token: string | null

  constructor(options: IntigritiClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.throttler = options.throttler
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.token = options.token ?? null
    this.retryOptions = {
      maxRetries: options.maxRetries,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      rand: options.rand,
      sleep: options.sleep
    }
  }

  setToken(token: string | null): void {
    this.token = token
  }

  getToken(): string | null {
    return this.token
  }

  listPrograms(params: { statusId?: number; typeId?: number; following?: boolean; limit?: number; offset?: number } = {}): Promise<Page<ProgramOverview>> {
    return this.request('/v1/programs', params, programOverviewPageSchema)
  }

  getProgram(programId: string): Promise<ProgramDetail> {
    return this.request(`/v1/programs/${programId}`, {}, programDetailSchema)
  }

  getProgramDomains(programId: string, versionId: string): Promise<ProgramDomains> {
    return this.request(`/v1/programs/${programId}/domains/${versionId}`, {}, programDomainsSchema)
  }

  getProgramRules(programId: string, versionId: string): Promise<ProgramRules> {
    return this.request(`/v1/programs/${programId}/rules-of-engagements/${versionId}`, {}, programRulesSchema)
  }

  listActivities(params: { createdSince?: number; following?: boolean; limit?: number; offset?: number } = {}): Promise<Page<ProgramActivity>> {
    return this.request('/v1/programs/activities', params, programActivityPageSchema)
  }

  private async request<T>(path: string, query: QueryParams, schema: z.ZodType<T>): Promise<T> {
    const token = this.token
    if (!token) {
      throw new AuthError('Jeton Intigriti absent. Connectez-vous.')
    }
    // Le quota est acquis a chaque tentative : un retry immediat (Retry-After: 0)
    // ne doit pas court-circuiter le throttler et marteler Intigriti.
    return withRetry(async () => {
      await this.throttler.acquire()
      return this.singleRequest(token, path, query, schema)
    }, this.retryOptions)
  }

  private async singleRequest<T>(token: string, path: string, query: QueryParams, schema: z.ZodType<T>): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(this.buildUrl(path, query), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': `Venari/${pkg.version}`
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw new NetworkError('Délai de réponse Intigriti dépassé.', { cause: error })
      }
      throw new NetworkError('Impossible de joindre api.intigriti.com.', { cause: error })
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`Accès refusé par Intigriti (HTTP ${response.status}).`)
    }
    if (response.status === 429) {
      throw new RateLimitError(parseRetryAfterMs(response.headers.get('retry-after')))
    }
    if (response.status >= 500) {
      throw new RetryableError(response.status, `Erreur Intigriti (HTTP ${response.status}).`)
    }
    if (!response.ok) {
      throw new ApiError(`Réponse inattendue d'Intigriti (HTTP ${response.status}).`)
    }

    let data: unknown
    try {
      data = await response.json()
    } catch (error) {
      throw new ApiError("Réponse d'Intigriti illisible (JSON invalide).", { cause: error })
    }

    try {
      return schema.parse(data)
    } catch (error) {
      throw new ApiError('Schéma de réponse Intigriti inattendu.', { cause: error })
    }
  }

  private buildUrl(path: string, query: QueryParams): string {
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) {
    return null
  }
  const seconds = Number.parseInt(header, 10)
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null
  }
  return Math.min(MAX_RETRY_AFTER_MS, seconds * 1000)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError'
}