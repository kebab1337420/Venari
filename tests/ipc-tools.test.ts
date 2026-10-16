import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, currentTools, installTool, clearGithubToken, loadGithubToken, saveGithubToken } =
  vi.hoisted(() => ({
    handlers: new Map<string, (...args: any[]) => Promise<any>>(),
    currentTools: vi.fn(),
    installTool: vi.fn(),
    clearGithubToken: vi.fn(),
    loadGithubToken: vi.fn(),
    saveGithubToken: vi.fn(),
  }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => Promise<any>) => {
      handlers.set(channel, fn)
    },
  },
}))

vi.mock('../src/main/storage', () => ({ clearGithubToken, loadGithubToken, saveGithubToken }))
vi.mock('../src/main/services/tools/installer', () => ({ currentTools, installTool }))

import { registerToolsIpc } from '../src/main/ipc-tools'
import { IPC } from '../src/shared/ipc'

function handler(channel: string): (...args: any[]) => Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler absent: ${channel}`)
  return fn
}

interface FakeSender {
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
}

function sender(destroyed = false): FakeSender {
  return { isDestroyed: () => destroyed, send: vi.fn() }
}

beforeEach(() => {
  handlers.clear()
  currentTools.mockReset()
  installTool.mockReset()
  clearGithubToken.mockReset()
  loadGithubToken.mockReset()
  saveGithubToken.mockReset()
  delete process.env.GITHUB_TOKEN
  registerToolsIpc()
})

afterEach(() => {
  delete process.env.GITHUB_TOKEN
})

describe('tools:list', () => {
  it('renvoie les outils detectes', async () => {
    currentTools.mockResolvedValue([{ id: 'nmap', installed: true }])
    await expect(handler(IPC.ToolsList)()).resolves.toEqual({
      ok: true,
      tools: [{ id: 'nmap', installed: true }],
    })
  })

  it('encapsule les erreurs sans rejetter la promesse', async () => {
    currentTools.mockRejectedValue(new Error('scan impossible'))
    await expect(handler(IPC.ToolsList)()).resolves.toEqual({ ok: false, error: 'scan impossible' })

    currentTools.mockRejectedValue('42')
    await expect(handler(IPC.ToolsList)()).resolves.toEqual({ ok: false, error: '42' })
  })
})

describe('tools:githubToken:get', () => {
  it('fait passer l\'environnement avant le stockage', async () => {
    process.env.GITHUB_TOKEN = 'de-env'
    loadGithubToken.mockReturnValue('du-stockage')

    const result = await handler(IPC.ToolsGitHubTokenGet)()

    expect(result).toEqual({ ok: true, configured: true })
    expect(loadGithubToken).not.toHaveBeenCalled()
  })

  it('retombe sur le stockage local', async () => {
    loadGithubToken.mockReturnValue('ghp_stocke')
    await expect(handler(IPC.ToolsGitHubTokenGet)()).resolves.toEqual({ ok: true, configured: true })
    expect(loadGithubToken).toHaveBeenCalledOnce()
  })

  it('signale l\'absence de jeton', async () => {
    loadGithubToken.mockReturnValue(null)
    await expect(handler(IPC.ToolsGitHubTokenGet)()).resolves.toEqual({ ok: true, configured: false })
  })

  it('encapsule une erreur de lecture', async () => {
    loadGithubToken.mockImplementation(() => {
      throw new Error('keyring indisponible')
    })
    await expect(handler(IPC.ToolsGitHubTokenGet)()).resolves.toEqual({
      ok: false,
      error: 'keyring indisponible',
    })
  })
})

describe('tools:githubToken:set', () => {
  it('refuse les valeurs non conformes sans les stocker', async () => {
    await expect(handler(IPC.ToolsGitHubTokenSet)({}, 42)).resolves.toEqual({
      ok: false,
      error: 'Token GitHub invalide.',
    })
    await expect(handler(IPC.ToolsGitHubTokenSet)({}, '')).resolves.toEqual({
      ok: false,
      error: 'Token GitHub invalide.',
    })
    await expect(handler(IPC.ToolsGitHubTokenSet)({}, 'x'.repeat(201))).resolves.toEqual({
      ok: false,
      error: 'Token GitHub invalide.',
    })
    expect(saveGithubToken).not.toHaveBeenCalled()
  })

  it('accepte la longueur maximale', async () => {
    saveGithubToken.mockReturnValue(undefined)
    const result = await handler(IPC.ToolsGitHubTokenSet)({}, 'x'.repeat(200))
    expect(result).toEqual({ ok: true })
    expect(saveGithubToken).toHaveBeenCalledWith('x'.repeat(200))
  })

  it('nettoie les espaces avant stockage', async () => {
    saveGithubToken.mockReturnValue(undefined)
    await expect(handler(IPC.ToolsGitHubTokenSet)({}, '  abc  ')).resolves.toEqual({ ok: true })
    expect(saveGithubToken).toHaveBeenCalledWith('abc')
  })

  it('encapsule une erreur d\'ecriture', async () => {
    saveGithubToken.mockImplementation(() => {
      throw new Error('ecriture refusee')
    })
    await expect(handler(IPC.ToolsGitHubTokenSet)({}, 'valide')).resolves.toEqual({
      ok: false,
      error: 'ecriture refusee',
    })
  })
})

describe('tools:githubToken:clear', () => {
  it('efface le jeton', async () => {
    await expect(handler(IPC.ToolsGitHubTokenClear)()).resolves.toEqual({ ok: true })
    expect(clearGithubToken).toHaveBeenCalledOnce()
  })

  it('encapsule une erreur', async () => {
    clearGithubToken.mockImplementation(() => {
      throw new Error('nettoyage impossible')
    })
    await expect(handler(IPC.ToolsGitHubTokenClear)()).resolves.toEqual({
      ok: false,
      error: 'nettoyage impossible',
    })
  })
})

describe('tools:install', () => {
  it('refuse un identifiant non conforme', async () => {
    const s = sender()
    await expect(handler(IPC.ToolsInstall)({ sender: s }, 42)).resolves.toEqual({
      ok: false,
      error: 'Identifiant d’outil invalide',
      output: '',
    })
    await expect(handler(IPC.ToolsInstall)({ sender: s }, '')).resolves.toEqual({
      ok: false,
      error: 'Identifiant d’outil invalide',
      output: '',
    })
    await expect(handler(IPC.ToolsInstall)({ sender: s }, 'x'.repeat(101))).resolves.toEqual({
      ok: false,
      error: 'Identifiant d’outil invalide',
      output: '',
    })
    expect(installTool).not.toHaveBeenCalled()
    expect(s.send).not.toHaveBeenCalled()
  })

  it('relaye la sortie au fil de l\'eau et joint le rendu final', async () => {
    installTool.mockImplementation(async (_id: string, out: (line: string) => void) => {
      out('telechargement...')
      out('termine')
      return { ok: true, installed: true }
    })
    const s = sender()

    const result = await handler(IPC.ToolsInstall)({ sender: s }, 'nmap')

    expect(result).toEqual({ ok: true, installed: true, output: 'telechargement...termine' })
    expect(s.send).toHaveBeenCalledTimes(2)
    expect(s.send).toHaveBeenNthCalledWith(1, IPC.ToolsInstallOutput, { id: 'nmap', line: 'telechargement...' })
    expect(s.send).toHaveBeenNthCalledWith(2, IPC.ToolsInstallOutput, { id: 'nmap', line: 'termine' })
  })

  it('n\'envoie plus rien une fois la fenetre detruite mais garde la sortie', async () => {
    installTool.mockImplementation(async (_id: string, out: (line: string) => void) => {
      out('encore visible')
      return { ok: true, installed: true }
    })
    const s = sender(true)

    const result = await handler(IPC.ToolsInstall)({ sender: s }, 'nmap')

    expect(result).toEqual({ ok: true, installed: true, output: 'encore visible' })
    expect(s.send).not.toHaveBeenCalled()
  })

  it('propage l\'echec de l\'installateur avec la sortie partielle', async () => {
    installTool.mockImplementation(async (_id: string, out: (line: string) => void) => {
      out('partiel')
      return { ok: false, error: 'depot inaccessible' }
    })
    const s = sender()

    const result = await handler(IPC.ToolsInstall)({ sender: s }, 'nmap')

    expect(result).toEqual({ ok: false, error: 'depot inaccessible', output: 'partiel' })
  })
})
