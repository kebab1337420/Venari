import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/shared/ipc'
import type { ProgramDetailData } from '../src/shared/ipc'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
  openExternal: vi.fn(),
  client: { getToken: vi.fn() },
  fetchProgramDetail: vi.fn(),
  getCachedProgramDetail: vi.fn(),
  addCredential: vi.fn(),
  listCredentials: vi.fn(),
  removeCredential: vi.fn(),
  revealCredentialSecret: vi.fn(),
  updateCredentialPatch: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) => {
      h.handlers.set(channel, fn)
    }
  },
  shell: { openExternal: h.openExternal }
}))

vi.mock('../src/main/app-state', () => ({ getClient: () => h.client }))
vi.mock('../src/main/services/program-detail', () => ({
  fetchProgramDetail: h.fetchProgramDetail,
  getCachedProgramDetail: h.getCachedProgramDetail
}))
vi.mock('../src/main/services/credentials', () => ({
  addCredential: h.addCredential,
  listCredentials: h.listCredentials,
  removeCredential: h.removeCredential,
  revealCredentialSecret: h.revealCredentialSecret,
  updateCredentialPatch: h.updateCredentialPatch
}))

import { registerDetailIpc } from '../src/main/ipc-detail'

const call = (channel: string, raw: unknown): unknown => h.handlers.get(channel)!(null, raw)

function detail(overrides: Partial<ProgramDetailData> = {}): ProgramDetailData {
  return {
    programId: 'p1',
    handle: 'acme',
    name: 'Acme',
    status: null,
    type: null,
    confidentiality: null,
    industry: null,
    webLink: null,
    minBounty: null,
    maxBounty: null,
    scope: [],
    roe: null,
    fetchedAt: Date.now(),
    ...overrides
  }
}

beforeAll(() => {
  registerDetailIpc()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(0))
  h.openExternal.mockImplementation(async () => undefined)
  h.client.getToken.mockImplementation(() => 'tok')
  h.fetchProgramDetail.mockImplementation(async () => detail())
  h.getCachedProgramDetail.mockImplementation(() => null)
  h.addCredential.mockImplementation(() => 7)
  h.listCredentials.mockImplementation(() => [])
  h.removeCredential.mockImplementation(() => undefined)
  h.revealCredentialSecret.mockImplementation(() => 'secret')
  h.updateCredentialPatch.mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ProgramDetailGet', () => {
  it('consulte l’API quand un token est configuré', async () => {
    const result = await call(IPC.ProgramDetailGet, 'p1')
    expect(result).toEqual({ ok: true, detail: detail() })
    expect(h.fetchProgramDetail).toHaveBeenCalledWith(h.client, 'p1')
    expect(h.getCachedProgramDetail).not.toHaveBeenCalled()
  })

  it('retombe sur le cache sans token', async () => {
    h.client.getToken.mockReturnValue(null)
    const cached = detail({ programId: 'p2' })
    h.getCachedProgramDetail.mockReturnValue(cached)
    const result = await call(IPC.ProgramDetailGet, 'p2')
    expect(result).toEqual({ ok: true, detail: cached })
    expect(h.fetchProgramDetail).not.toHaveBeenCalled()
  })

  it('signale l’absence de token et de cache', async () => {
    h.client.getToken.mockReturnValue(null)
    const result = await call(IPC.ProgramDetailGet, 'p3')
    expect(result).toEqual({ ok: false, error: 'Aucun token configuré ni cache disponible' })
  })

  it('remonte le message d’erreur de l’API', async () => {
    h.fetchProgramDetail.mockRejectedValue(new Error('boom'))
    const result = await call(IPC.ProgramDetailGet, 'p1')
    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('renvoie une erreur sur un identifiant de programme invalide', async () => {
    const result = await call(IPC.ProgramDetailGet, '')
    expect(result).toMatchObject({ ok: false })
  })
})

describe('Credentials', () => {
  it('liste les identifiants du programme', () => {
    h.listCredentials.mockReturnValue([{ id: 1 }])
    const result = call(IPC.CredentialsList, 'p1')
    expect(result).toEqual({ ok: true, credentials: [{ id: 1 }] })
    expect(h.listCredentials).toHaveBeenCalledWith('p1')
  })

  it('révèle le secret de la ligne demandée', () => {
    const result = call(IPC.CredentialsReveal, 1)
    expect(result).toEqual({ ok: true, secret: 'secret' })
    expect(h.revealCredentialSecret).toHaveBeenCalledWith(1)
  })

  it('refuse quand le déchiffrement échoue', () => {
    h.revealCredentialSecret.mockReturnValue(null)
    const result = call(IPC.CredentialsReveal, 1)
    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toContain('illisible')
  })

  it('ajoute un identifiant en appliquant les valeurs par défaut', () => {
    const result = call(IPC.CredentialsAdd, { programId: 'p1', label: '  login  ' })
    expect(result).toEqual({ ok: true, id: 7 })
    expect(h.addCredential).toHaveBeenCalledWith({
      programId: 'p1',
      label: 'login',
      username: '',
      secret: '',
      note: ''
    })
  })

  it('refuse un libellé vide', () => {
    const result = call(IPC.CredentialsAdd, { programId: 'p1', label: '   ' })
    expect(result).toMatchObject({ ok: false })
  })

  it('met à jour partiellement et ignore programId', () => {
    const result = call(IPC.CredentialsUpdate, { id: 4, patch: { programId: 'p2', secret: 'x' } })
    expect(result).toEqual({ ok: true })
    expect(h.updateCredentialPatch).toHaveBeenCalledWith(4, { secret: 'x' })
  })

  it('ne réinitialise pas les champs omis d’un patch partiel', () => {
    const result = call(IPC.CredentialsUpdate, { id: 4, patch: { note: 'n' } })
    expect(result).toEqual({ ok: true })
    const [, patch] = h.updateCredentialPatch.mock.calls[0]!
    expect(patch).toEqual({ note: 'n' })
    expect(patch).not.toHaveProperty('username')
    expect(patch).not.toHaveProperty('label')
  })

  it('supprime un identifiant', () => {
    const result = call(IPC.CredentialsRemove, 9)
    expect(result).toEqual({ ok: true })
    expect(h.removeCredential).toHaveBeenCalledWith(9)
  })
})

describe('OpenExternal', () => {
  it('ouvre une URL http(s)', async () => {
    const result = await call(IPC.OpenExternal, 'https://example.com')
    expect(result).toEqual({ ok: true })
    expect(h.openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('refuse un protocole non http(s) pourtant valide', async () => {
    for (const url of ['ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd']) {
      const result = await call(IPC.OpenExternal, url)
      expect(result).toEqual({ ok: false, error: 'Protocole non autorisé' })
    }
    expect(h.openExternal).not.toHaveBeenCalled()
  })

  it('signale une chaîne qui n’est pas une URL', async () => {
    const result = await call(IPC.OpenExternal, 'pas une url')
    expect(result).toMatchObject({ ok: false })
  })
})
