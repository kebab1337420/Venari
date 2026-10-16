import { describe, expect, it } from 'vitest'
import {
  ApiError,
  AuthError,
  BountyDeskError,
  HttpError,
  NetworkError,
  RateLimitError,
  RetryableError,
  isRetryable,
} from '../src/services/intigriti/errors'

describe('hierarchie des erreurs', () => {
  it('nomme chaque erreur d\'apres sa sous-classe', () => {
    expect(new BountyDeskError('x').name).toBe('BountyDeskError')
    expect(new ApiError('x').name).toBe('ApiError')
    expect(new AuthError('x').name).toBe('AuthError')
    expect(new RateLimitError().name).toBe('RateLimitError')
    expect(new RetryableError(500, 'x').name).toBe('RetryableError')
    expect(new HttpError(500, 'x').name).toBe('HttpError')
    expect(new NetworkError('x').name).toBe('NetworkError')
  })

  it('relie les erreurs API a la racine', () => {
    const error = new AuthError('refus')
    expect(error).toBeInstanceOf(AuthError)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toBeInstanceOf(BountyDeskError)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('refus')
  })

  it('les erreurs reseau ne sont pas des erreurs API', () => {
    const error = new NetworkError('deconnecte')
    expect(error).toBeInstanceOf(BountyDeskError)
    expect(error).not.toBeInstanceOf(ApiError)
  })

  it('conserve la cause transmise', () => {
    const cause = new Error('origine')
    const error = new BountyDeskError('enveloppe', { cause })
    expect(error.cause).toBe(cause)
  })
})

describe('RateLimitError', () => {
  it('applique le delai et le message par defaut', () => {
    const error = new RateLimitError()
    expect(error.retryAfterMs).toBeNull()
    expect(error.message).toBe('Trop de requêtes.')
  })

  it('accepte un delai et un message personnalises', () => {
    const error = new RateLimitError(1500, 'Doucement')
    expect(error.retryAfterMs).toBe(1500)
    expect(error.message).toBe('Doucement')
  })
})

describe('erreurs portant un statut', () => {
  it('expose le statut de RetryableError et HttpError', () => {
    expect(new RetryableError(503, 'indisponible').status).toBe(503)
    expect(new HttpError(418, 'théière').status).toBe(418)
    expect(new HttpError(418, 'théière').message).toBe('théière')
  })
})

describe('isRetryable', () => {
  it('classe les erreurs temporaires comme reessayables', () => {
    expect(isRetryable(new RetryableError(502, 'x'))).toBe(true)
    expect(isRetryable(new RateLimitError())).toBe(true)
    expect(isRetryable(new NetworkError('x'))).toBe(true)
  })

  it('ne reessaie ni les refus d\'authentification ni les erreurs HTTP definitives', () => {
    expect(isRetryable(new AuthError('x'))).toBe(false)
    expect(isRetryable(new HttpError(400, 'x'))).toBe(false)
    expect(isRetryable(new ApiError('x'))).toBe(false)
    expect(isRetryable(new Error('x'))).toBe(false)
  })

  it('reste robuste face aux valeurs non-erreur', () => {
    expect(isRetryable(null)).toBe(false)
    expect(isRetryable(undefined)).toBe(false)
    expect(isRetryable('503')).toBe(false)
    expect(isRetryable({})).toBe(false)
  })
})
