import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ipcMain } from 'electron'
import { IPC } from '../src/shared/ipc'

// On ne teste ici que les gardes purement logiques de ipc-browser : la creation
// de fenetre passe par `require('electron')` (import tardif voulu pour l'agent
// headless) qui echappe au mock de module. Les tests couvrent donc la politique
// d'URL -- le point sensible -- et l'enregistrement du canal IPC.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { isTrustedShellUrl, registerBrowserIpc } from '../src/main/ipc-browser'

const shellHref = pathToFileURL(join(process.cwd(), 'src/renderer/browser.html')).href

afterEach(() => {
  delete process.env.ELECTRON_RENDERER_URL
})

describe('isTrustedShellUrl — page de confiance locale', () => {
  beforeEach(() => {
    delete process.env.ELECTRON_RENDERER_URL
  })

  it('accepte la page browser.html et ses variantes de requete/fragment', () => {
    expect(isTrustedShellUrl(shellHref)).toBe(true)
    expect(isTrustedShellUrl(shellHref + '?url=https%3A%2F%2Fexample.com')).toBe(true)
    expect(isTrustedShellUrl(shellHref + '#ancre')).toBe(true)
  })

  it('refuse toute autre page locale, qui heriterait du pont IPC', () => {
    expect(isTrustedShellUrl(pathToFileURL(join(process.cwd(), 'src/renderer/index.html')).href)).toBe(false)
    expect(isTrustedShellUrl(shellHref + '/../secret.html')).toBe(false)
    expect(isTrustedShellUrl('file:///etc/passwd')).toBe(false)
  })

  it('refuse les URL distantes et les schemes exotiques', () => {
    expect(isTrustedShellUrl('https://example.com')).toBe(false)
    expect(isTrustedShellUrl('http://example.com/')).toBe(false)
    expect(isTrustedShellUrl('javascript:alert(1)')).toBe(false)
    expect(isTrustedShellUrl('')).toBe(false)
  })
})

describe('isTrustedShellUrl — serveur de developpement', () => {
  it('accepte la racine et ses sous-chemins du serveur vite', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    expect(isTrustedShellUrl('http://localhost:5173')).toBe(true)
    expect(isTrustedShellUrl('http://localhost:5173/')).toBe(true)
    expect(isTrustedShellUrl('http://localhost:5173/browser.html')).toBe(true)
  })

  it('tolere une barre finale dans la variable enregistree', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
    expect(isTrustedShellUrl('http://localhost:5173/browser.html')).toBe(true)
    expect(isTrustedShellUrl('http://localhost:5173')).toBe(true)
  })

  it('refuse un hote ou un port voisin (pas seulement un prefixe de chaine)', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    expect(isTrustedShellUrl('http://localhost:5174')).toBe(false)
    expect(isTrustedShellUrl('http://localhost:51730')).toBe(false)
    expect(isTrustedShellUrl('http://localhost:5173.evil.com')).toBe(false)
  })
})

describe('registerBrowserIpc', () => {
  it('enregistre le canal BrowserOpen', () => {
    vi.mocked(ipcMain.handle).mockClear()
    registerBrowserIpc()
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.BrowserOpen, expect.any(Function))
  })

  it('refuse les schemes non http(s) sans ouvrir de fenetre', async () => {
    vi.mocked(ipcMain.handle).mockClear()
    registerBrowserIpc()
    const handler = vi.mocked(ipcMain.handle).mock.calls[0]![1] as (
      e: unknown,
      url?: string
    ) => Promise<{ ok: boolean; error?: string }>

    await expect(handler({}, 'ftp://example.com')).resolves.toEqual({
      ok: false,
      error: 'URL refusee : seuls http et https sont acceptes.'
    })
  })
})
