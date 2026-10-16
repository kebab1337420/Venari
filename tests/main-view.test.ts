import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeWindow {
  id: number
  webContents: { id: number }
  options: { title?: string; webPreferences?: Record<string, unknown> }
  shown: boolean
  loadedUrl: string | null
  loadedFile: string | null
  fire: (event: string) => void
}

const hoisted = vi.hoisted(() => ({
  nextId: 1,
  instances: [] as unknown[],
}))

vi.mock('electron', () => {
  class FakeBrowserWindow {
    id = hoisted.nextId++
    webContents = { id: this.id }
    options: { title?: string; webPreferences?: Record<string, unknown> }
    shown = false
    loadedUrl: string | null = null
    loadedFile: string | null = null
    private handlers = new Map<string, (() => void)[]>()

    constructor(options: { title?: string; webPreferences?: Record<string, unknown> }) {
      this.options = options
      hoisted.instances.push(this)
    }

    on(event: string, cb: () => void): this {
      const list = this.handlers.get(event) ?? []
      list.push(cb)
      this.handlers.set(event, list)
      return this
    }

    fire(event: string): void {
      for (const cb of this.handlers.get(event) ?? []) cb()
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
  return { BrowserWindow: FakeBrowserWindow }
})

import { getViewTokenForSender, openAgentView } from '../src/main/view'

const instances = (): FakeWindow[] => hoisted.instances as FakeWindow[]

describe('src/main/view.ts (fenetre de vue distante)', () => {
  beforeEach(() => {
    hoisted.instances.length = 0
    hoisted.nextId = 1
    delete process.env['ELECTRON_RENDERER_URL']
  })

  afterEach(() => {
    delete process.env['ELECTRON_RENDERER_URL']
  })

  it('associe le jeton de vue au webContents de la fenetre ouverte', () => {
    openAgentView('jeton-secret', 'poste-alice')
    const win = instances()[0]!
    expect(getViewTokenForSender(win.webContents.id)).toBe('jeton-secret')
  })

  it('ne rend aucun jeton pour un webContents inconnu', () => {
    openAgentView('jeton-secret', 'poste-alice')
    expect(getViewTokenForSender(9999)).toBeNull()
  })

  it('oublie le jeton quand la fenetre se ferme', () => {
    openAgentView('jeton-secret', 'poste-alice')
    const win = instances()[0]!
    expect(getViewTokenForSender(win.webContents.id)).toBe('jeton-secret')
    win.fire('closed')
    expect(getViewTokenForSender(win.webContents.id)).toBeNull()
  })

  it('n affiche la fenetre qu au ready-to-show', () => {
    openAgentView('jeton-secret', 'poste-alice')
    const win = instances()[0]!
    expect(win.shown).toBe(false)
    win.fire('ready-to-show')
    expect(win.shown).toBe(true)
  })

  it('ouvre une fenetre isolee (sandbox, pas de node) chargeant view.html', () => {
    openAgentView('jeton-secret', 'poste-alice')
    const win = instances()[0]!
    expect(win.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
    expect(win.options.title).toContain('poste-alice')
    expect(win.loadedFile).toMatch(/renderer[\\/]view\.html$/)
  })

  it('utilise le serveur de developpement quand ELECTRON_RENDERER_URL est defini', () => {
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173/'
    openAgentView('jeton-secret', 'poste-alice')
    const win = instances()[0]!
    expect(win.loadedUrl).toBe('http://localhost:5173/view.html')
    expect(win.loadedFile).toBeNull()
  })

  it('n expose jamais le jeton hors d une fenetre de vue connue', () => {
    openAgentView('jeton-secret', 'poste-alice')
    openAgentView('autre-jeton', 'poste-bob')
    const [first, second] = instances()
    expect(getViewTokenForSender(first!.webContents.id)).toBe('jeton-secret')
    expect(getViewTokenForSender(second!.webContents.id)).toBe('autre-jeton')
  })
})
