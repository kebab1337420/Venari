import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const instances: FakeClient[] = []
  const state = {
    listPrograms: async (): Promise<unknown> => ({ content: [], pagination: {} }),
  }
  class FakeAuthError extends Error {}
  class FakeClient {
    token: string | null = null
    constructor(opts: { token?: string } = {}) {
      this.token = opts.token ?? null
      instances.push(this)
    }
    setToken(token: string | null): void {
      this.token = token
    }
    getToken(): string | null {
      return this.token
    }
    listPrograms(): Promise<unknown> {
      return state.listPrograms()
    }
  }
  class FakeThrottler {
    constructor(_options?: unknown) {}
  }
  return { instances, state, FakeAuthError, FakeClient, FakeThrottler }
})

const loadToken = vi.fn()
const saveToken = vi.fn()
const clearToken = vi.fn()

vi.mock('../src/main/storage', () => ({
  loadToken: (...args: unknown[]) => loadToken(...args),
  saveToken: (...args: unknown[]) => saveToken(...args),
  clearToken: (...args: unknown[]) => clearToken(...args),
}))

vi.mock('../src/services/intigriti', () => ({
  IntigritiClient: h.FakeClient,
  Throttler: h.FakeThrottler,
  RATE_LIMIT: {},
  AuthError: h.FakeAuthError,
}))

import { AuthError } from '../src/services/intigriti'
import {
  clearTokenFromStore,
  getClient,
  hasToken,
  restoreToken,
  validateAndStoreToken,
} from '../src/main/app-state'

beforeEach(() => {
  getClient().setToken(null)
  h.state.listPrograms = async () => ({ content: [], pagination: {} })
  loadToken.mockReset()
  saveToken.mockReset()
  clearToken.mockReset()
})

describe('restoreToken / hasToken', () => {
  it('restaure le jeton stocke dans le client', () => {
    loadToken.mockReturnValue('tok-123')

    restoreToken()

    expect(loadToken).toHaveBeenCalledOnce()
    expect(getClient().getToken()).toBe('tok-123')
    expect(hasToken()).toBe(true)
  })

  it('ne touche pas le client quand aucun jeton n\'est stocke', () => {
    loadToken.mockReturnValue(null)
    getClient().setToken('existait-avant')

    restoreToken()

    expect(getClient().getToken()).toBe('existait-avant')
    expect(hasToken()).toBe(true)
  })
})

describe('validateAndStoreToken', () => {
  it('valide, persiste et installe le jeton', async () => {
    const result = await validateAndStoreToken('nouveau')

    expect(result).toEqual({ ok: true })
    expect(saveToken).toHaveBeenCalledWith('nouveau')
    expect(getClient().getToken()).toBe('nouveau')
  })

  it('refuse un jeton rejete par Intigriti sans le stocker', async () => {
    h.state.listPrograms = async () => {
      throw new AuthError('401')
    }

    const result = await validateAndStoreToken('mauvais')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Token refusé par Intigriti')
    expect(saveToken).not.toHaveBeenCalled()
    expect(getClient().getToken()).toBeNull()
  })

  it('signale une panne reseau avec le message d\'origine', async () => {
    h.state.listPrograms = async () => {
      throw new Error('connexion refusee')
    }

    const result = await validateAndStoreToken('mauvais')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Impossible de joindre Intigriti')
    expect(result.error).toContain('connexion refusee')
    expect(saveToken).not.toHaveBeenCalled()
  })

  it('gere une erreur non standard', async () => {
    h.state.listPrograms = async () => {
      throw 'boum'
    }

    const result = await validateAndStoreToken('mauvais')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('erreur inconnue')
  })
})

describe('clearTokenFromStore', () => {
  it('efface le jeton du stockage et du client', () => {
    getClient().setToken('a-supprimer')

    clearTokenFromStore()

    expect(clearToken).toHaveBeenCalledOnce()
    expect(getClient().getToken()).toBeNull()
    expect(hasToken()).toBe(false)
  })
})
