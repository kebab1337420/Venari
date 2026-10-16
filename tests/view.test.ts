import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const instances: any[] = []
  let nextId = 1
  class FakeBrowserWindow {
    handlers = new Map<string, (...args: any[]) => void>()
    options: any
    loadedUrl: string | null = null
    loadedFile: string | null = null
    shown = false
    webContents: { id: number }
    constructor(options: any) {
      this.options = options
      this.webContents = { id: nextId++ }
      instances.push(this)
    }
    on(event: string, fn: (...args: any[]) => void): void {
      this.handlers.set(event, fn)
    }
    emit(event: string): void {
      this.handlers.get(event)?.()
    }
    show(): void {
      this.shown = true
    }
    loadURL(url: string): Promise<void> {
      this.loadedUrl = url
      return Promise.resolve()
    }
    loadFile(file: string): Promise<void> {
      this.loadedFile = file
      return Promise.resolve()
    }
  }
  return {
    instances,
    FakeBrowserWindow,
    purge(): void {
      for (const win of instances) win.emit('closed')
      instances.length = 0
    },
  }
})

vi.mock('electron', () => ({ BrowserWindow: state.FakeBrowserWindow }))

import { getViewTokenForSender, openAgentView } from '../src/main/view'

beforeEach(() => {
  state.purge()
  delete process.env.ELECTRON_RENDERER_URL
})

afterEach(() => {
  delete process.env.ELECTRON_RENDERER_URL
})

describe('cycle de vie du jeton de vue', () => {
  it('associe le jeton au webContents de la fenetre ouverte', () => {
    openAgentView('jeton-a', 'PC du salon')

    const win = state.instances[0]
    expect(getViewTokenForSender(win.webContents.id)).toBe('jeton-a')
  })

  it('garde les jetons cloisonnes entre fenetres', () => {
    openAgentView('jeton-a', 'A')
    openAgentView('jeton-b', 'B')

    const [a, b] = state.instances
    expect(getViewTokenForSender(a.webContents.id)).toBe('jeton-a')
    expect(getViewTokenForSender(b.webContents.id)).toBe('jeton-b')
  })

  it('ne reconnait aucun expediteur inconnu', () => {
    expect(getViewTokenForSender(9999)).toBeNull()

    openAgentView('jeton-a', 'A')
    expect(getViewTokenForSender(9999)).toBeNull()
  })

  it('oublie le jeton a la fermeture de la fenetre', () => {
    openAgentView('jeton-a', 'A')
    const id = state.instances[0].webContents.id
    expect(getViewTokenForSender(id)).toBe('jeton-a')

    state.instances[0].emit('closed')

    expect(getViewTokenForSender(id)).toBeNull()
  })

  it('n affiche la fenetre qu apres ready-to-show', () => {
    openAgentView('jeton-a', 'A')
    const win = state.instances[0]

    expect(win.shown).toBe(false)
    win.emit('ready-to-show')
    expect(win.shown).toBe(true)
  })
})

describe('isolation de la fenetre', () => {
  it('impose sandbox et contextIsolation sans integration Node', () => {
    openAgentView('jeton-a', 'A')

    const { webPreferences } = state.instances[0].options
    expect(webPreferences.sandbox).toBe(true)
    expect(webPreferences.contextIsolation).toBe(true)
    expect(webPreferences.nodeIntegration).toBe(false)
    expect(webPreferences.preload).toMatch(/preload[/\\]index\.js$/)
  })

  it('titre la fenetre avec le libelle distant', () => {
    openAgentView('jeton-a', 'Bureau de test')
    expect(state.instances[0].options.title).toContain('Bureau de test')
  })
})

describe('chargement de la page de vue', () => {
  it('charge l URL du serveur de developpement', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
    openAgentView('jeton-a', 'A')

    const win = state.instances[0]
    expect(win.loadedUrl).toBe('http://localhost:5173/view.html')
    expect(win.loadedFile).toBeNull()
  })

  it('charge le fichier embarque hors developpement', () => {
    openAgentView('jeton-a', 'A')

    const win = state.instances[0]
    expect(win.loadedUrl).toBeNull()
    expect(win.loadedFile).toMatch(/renderer[/\\]view\.html$/)
  })
})
