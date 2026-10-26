import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/shared/ipc'

type Handler = (event: unknown, raw: unknown) => unknown

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  hasToken: vi.fn<() => boolean>(),
  usingSystemKeyring: vi.fn<() => boolean>(),
  validateAndStoreToken: vi.fn<(token: string) => Promise<unknown>>(),
  clearTokenFromStore: vi.fn<() => void>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      h.handlers.set(channel, fn)
    },
  },
}))
vi.mock('../src/main/app-state', () => ({
  hasToken: h.hasToken,
  validateAndStoreToken: h.validateAndStoreToken,
  clearTokenFromStore: h.clearTokenFromStore,
}))
vi.mock('../src/main/storage', () => ({ usingSystemKeyring: h.usingSystemKeyring }))

import { registerIpc } from '../src/main/ipc'

const call = async (channel: string, raw?: unknown): Promise<unknown> =>
  h.handlers.get(channel)!(null, raw)

beforeAll(() => {
  registerIpc()
})

beforeEach(() => {
  vi.clearAllMocks()
  h.hasToken.mockReturnValue(true)
  h.usingSystemKeyring.mockReturnValue(true)
  h.validateAndStoreToken.mockResolvedValue({ ok: true })
})

describe('AuthStatus', () => {
  it('rapporte la presence du jeton et du keyring', async () => {
    const result = await call(IPC.AuthStatus)
    expect(result).toEqual({ configured: true, keyring: true })
  })

  it('rapporte l absence de jeton', async () => {
    h.hasToken.mockReturnValue(false)
    h.usingSystemKeyring.mockReturnValue(false)
    const result = await call(IPC.AuthStatus)
    expect(result).toEqual({ configured: false, keyring: false })
  })
})

describe('AuthValidate', () => {
  it('delegue la validation et le stockage pour un jeton valide', async () => {
    h.validateAndStoreToken.mockResolvedValue({ ok: true })
    const result = await call(IPC.AuthValidate, 'abcdefghij')
    expect(result).toEqual({ ok: true })
    expect(h.validateAndStoreToken).toHaveBeenCalledWith('abcdefghij')
  })

  it('refuse un jeton trop court sans appeler le reseau', async () => {
    const result = await call(IPC.AuthValidate, '123456789')
    expect(result).toEqual({ ok: false, error: 'Format de token invalide.' })
    expect(h.validateAndStoreToken).not.toHaveBeenCalled()
  })

  it('refuse un jeton trop long', async () => {
    const result = await call(IPC.AuthValidate, 'x'.repeat(501))
    expect(result).toEqual({ ok: false, error: 'Format de token invalide.' })
    expect(h.validateAndStoreToken).not.toHaveBeenCalled()
  })

  it('refuse une valeur qui n est pas une chaine', async () => {
    const result = await call(IPC.AuthValidate, 42)
    expect(result).toEqual({ ok: false, error: 'Format de token invalide.' })
    expect(h.validateAndStoreToken).not.toHaveBeenCalled()
  })

  it('propage le resultat d echec du service', async () => {
    h.validateAndStoreToken.mockResolvedValue({ ok: false, error: 'Jeton invalide' })
    const result = await call(IPC.AuthValidate, 'abcdefghij')
    expect(result).toEqual({ ok: false, error: 'Jeton invalide' })
  })
})

describe('AuthClear', () => {
  it('efface le jeton stocke', async () => {
    await call(IPC.AuthClear)
    expect(h.clearTokenFromStore).toHaveBeenCalledTimes(1)
  })
})
