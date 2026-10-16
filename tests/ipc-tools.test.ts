import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/shared/ipc'

const hoisted = vi.hoisted(() => {
  const currentTools = vi.fn(
    async (): Promise<Array<{ id: string; installed: boolean }>> => [{ id: 'nuclei', installed: true }]
  )
  const installTool = vi.fn(
    async (
      _id: string,
      _out: (line: string) => void
    ): Promise<{ ok: boolean; installed?: boolean; error?: string }> => ({ ok: true, installed: true })
  )
  const loadGithubToken = vi.fn((): string | null => null)
  const saveGithubToken = vi.fn()
  const clearGithubToken = vi.fn()
  return {
    handlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
    currentTools,
    installTool,
    loadGithubToken,
    saveGithubToken,
    clearGithubToken
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) => {
      hoisted.handlers.set(channel, fn)
    }
  }
}))

vi.mock('../src/main/storage', () => ({
  loadGithubToken: hoisted.loadGithubToken,
  saveGithubToken: hoisted.saveGithubToken,
  clearGithubToken: hoisted.clearGithubToken
}))

vi.mock('../src/main/services/tools/installer', () => ({
  currentTools: hoisted.currentTools,
  installTool: hoisted.installTool
}))

import { registerToolsIpc } from '../src/main/ipc-tools'

const call = (channel: string, raw?: unknown) => hoisted.handlers.get(channel)!(null, raw)

const fakeSender = () => ({ isDestroyed: () => false, send: vi.fn() })

const originalGithubToken = process.env.GITHUB_TOKEN

beforeAll(() => {
  registerToolsIpc()
})

beforeEach(() => {
  hoisted.currentTools.mockResolvedValue([{ id: 'nuclei', installed: true }])
  hoisted.installTool.mockResolvedValue({ ok: true, installed: true })
  hoisted.loadGithubToken.mockReturnValue(null)
  delete process.env.GITHUB_TOKEN
})

afterAll(() => {
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalGithubToken
})

describe('ToolsList', () => {
  it('renvoie les outils disponibles', async () => {
    expect(await call(IPC.ToolsList)).toEqual({ ok: true, tools: [{ id: 'nuclei', installed: true }] })
  })

  it('renvoie une erreur quand la détection échoue', async () => {
    hoisted.currentTools.mockRejectedValueOnce(new Error('boom'))
    expect(await call(IPC.ToolsList)).toEqual({ ok: false, error: 'boom' })
  })
})

describe('ToolsGitHubTokenGet', () => {
  it('configuré via le jeton stocké', async () => {
    hoisted.loadGithubToken.mockReturnValue('ghp_stored')
    expect(await call(IPC.ToolsGitHubTokenGet)).toEqual({ ok: true, configured: true })
  })

  it('non configuré quand rien n’est stocké', async () => {
    expect(await call(IPC.ToolsGitHubTokenGet)).toEqual({ ok: true, configured: false })
  })

  it('un jeton stocké vide ne compte pas comme configuré', async () => {
    hoisted.loadGithubToken.mockReturnValue('')
    expect(await call(IPC.ToolsGitHubTokenGet)).toEqual({ ok: true, configured: false })
  })

  it('configuré via la variable d’environnement', async () => {
    process.env.GITHUB_TOKEN = 'ghp_env'
    expect(await call(IPC.ToolsGitHubTokenGet)).toEqual({ ok: true, configured: true })
  })

  it('une variable d’environnement vide retombe sur le stockage', async () => {
    process.env.GITHUB_TOKEN = ''
    hoisted.loadGithubToken.mockReturnValue('ghp_stored')
    expect(await call(IPC.ToolsGitHubTokenGet)).toEqual({ ok: true, configured: true })
  })
})

describe('ToolsGitHubTokenSet', () => {
  it('enregistre un jeton en retirant les espaces', async () => {
    expect(await call(IPC.ToolsGitHubTokenSet, '  ghp_x  ')).toEqual({ ok: true })
    expect(hoisted.saveGithubToken).toHaveBeenCalledWith('ghp_x')
  })

  it('refuse un jeton vide ou composé d’espaces', async () => {
    expect(await call(IPC.ToolsGitHubTokenSet, '   ')).toEqual({ ok: false, error: 'Token GitHub invalide.' })
    expect(await call(IPC.ToolsGitHubTokenSet, '')).toEqual({ ok: false, error: 'Token GitHub invalide.' })
    expect(hoisted.saveGithubToken).not.toHaveBeenCalled()
  })

  it('refuse une valeur qui n’est pas du texte', async () => {
    expect(await call(IPC.ToolsGitHubTokenSet, 42)).toEqual({ ok: false, error: 'Token GitHub invalide.' })
  })

  it('refuse un jeton trop long', async () => {
    expect(await call(IPC.ToolsGitHubTokenSet, 'a'.repeat(201))).toEqual({ ok: false, error: 'Token GitHub invalide.' })
  })
})

describe('ToolsGitHubTokenClear', () => {
  it('efface le jeton stocké', async () => {
    expect(await call(IPC.ToolsGitHubTokenClear)).toEqual({ ok: true })
    expect(hoisted.clearGithubToken).toHaveBeenCalled()
  })
})

describe('ToolsInstall', () => {
  it('refuse un identifiant invalide', async () => {
    const sender = fakeSender()
    expect(await hoisted.handlers.get(IPC.ToolsInstall)!({ sender }, '')).toEqual({
      ok: false,
      error: 'Identifiant d’outil invalide',
      output: ''
    })
    expect(await hoisted.handlers.get(IPC.ToolsInstall)!({ sender }, 123)).toEqual({
      ok: false,
      error: 'Identifiant d’outil invalide',
      output: ''
    })
    expect(hoisted.installTool).not.toHaveBeenCalled()
  })

  it('diffuse la sortie au fil de l’eau et renvoie le résultat', async () => {
    const sender = fakeSender()
    hoisted.installTool.mockImplementationOnce(async (_id, out) => {
      out('ligne 1\n')
      out('ligne 2\n')
      return { ok: true, installed: true }
    })
    const res = await hoisted.handlers.get(IPC.ToolsInstall)!({ sender }, 'nuclei')
    expect(res).toEqual({ ok: true, installed: true, output: 'ligne 1\nligne 2\n' })
    expect(sender.send).toHaveBeenCalledWith(IPC.ToolsInstallOutput, { id: 'nuclei', line: 'ligne 1\n' })
    expect(sender.send).toHaveBeenCalledTimes(2)
  })

  it('renvoie l’erreur d’installation', async () => {
    const sender = fakeSender()
    hoisted.installTool.mockResolvedValueOnce({ ok: false, error: 'échec réseau' })
    expect(await hoisted.handlers.get(IPC.ToolsInstall)!({ sender }, 'nuclei')).toEqual({
      ok: false,
      error: 'échec réseau',
      output: ''
    })
  })

  it('n’écrit pas sur un rendu détruit', async () => {
    const sender = { isDestroyed: () => true, send: vi.fn() }
    hoisted.installTool.mockImplementationOnce(async (_id, out) => {
      out('ligne\n')
      return { ok: true, installed: true }
    })
    await hoisted.handlers.get(IPC.ToolsInstall)!({ sender }, 'nuclei')
    expect(sender.send).not.toHaveBeenCalled()
  })
})
