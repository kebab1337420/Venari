import { ipcMain } from 'electron'
import type { BrowserWindow, Session } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/ipc'

/**
 * Fenetre de navigation utilisee par l'onglet Assistant.
 *
 * Elle charge uniquement `browser.html` (page de confiance du projet). Le site
 * visite est rendu dans un iframe sandboxe, sans `allow-same-origin` : le
 * contenu distant n'a donc jamais acces au pont `bountydesk` expose par le
 * preload, ni a l'API IPC privilegiee.
 */
let browserWindow: BrowserWindow | null = null

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Partition propre au navigateur Assistant.
 *
 * Le CSP global de `installSecurity` vaut `default-src 'self'`, et `frame-src`
 * en herite : sans partition dediee, l'iframe serait bloquee sur toute URL
 * distante. Cette session elargit uniquement `frame-src` ; `connect-src` reste
 * a 'none' et le contenu distant tourne dans une iframe sandboxee sans
 * `allow-same-origin`, donc sans acces au pont `bountydesk`.
 */
const BROWSER_PARTITION = 'bountydesk-browser'

const BROWSER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Seul elargissement : autoriser l'iframe a charger le site demande.
  "frame-src http: https:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ')

let cspRegistered = false

function browserSession(): Session {
  // Import tardif : le serveur MCP tourne aussi hors Electron (tests, agent
  // headless). Un `import` statique de `session` ferait echouer le chargement
  // du module la ou aucun BrowserWindow n'existe.
  const { session } = require('electron') as typeof import('electron')
  const ses = session.fromPartition(BROWSER_PARTITION)
  // La partition dediee n'herite pas des handlers poses sur defaultSession
  // (security.ts) : sans ces deux appels, Electron auto-approuverait toute
  // demande de permission (notifications, geoloc, micro/camera, presse-papiers).
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  if (!cspRegistered) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      // Ce CSP n'est écrit que sur la page de confiance. Étendu aux réponses
      // distantes, il frapperait aussi le document de l'iframe :
      // `connect-src 'none'` y interdirait ses appels réseau et
      // `script-src 'self'` ses scripts tiers — l'Assistant ne naviguerait
      // sur aucun site dynamique. L'isolation de l'iframe ne vient pas d'ici
      // (attribut sandbox sans allow-same-origin), elle ne dépend pas du CSP.
      if (!isTrustedShellUrl(details.url)) {
        callback({ responseHeaders: details.responseHeaders })
        return
      }
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [BROWSER_CSP] } })
    })
    cspRegistered = true
  }
  return ses
}

/** Exporté pour test : c'est la garde qui empêche une page locale de hériter du pont IPC. */
export function isTrustedShellUrl(value: string): boolean {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    const base = devServerUrl.endsWith('/') ? devServerUrl.slice(0, -1) : devServerUrl
    if (value === base || value.startsWith(base + '/')) return true
  }
  // file:// doit designer *la* page de confiance et rien d'autre : toute autre
  // page locale chargerait le pont bountydesk du preload, c'est-à-dire l'accès
  // complet à l'IPC du processus principal.
  const shell = pathToFileURL(join(__dirname, '../renderer/browser.html')).href
  return value === shell || value.startsWith(shell + '?') || value.startsWith(shell + '#')
}

/**
 * Ouvre (ou reactive) la fenetre Assistant sur `targetUrl` si elle est un http(s).
 *
 * La page de confiance reste le point d'entree : l'URL demandee est transmise
 * en parametre de requete et rendue dans l'iframe sandboxe, jamais chargee
 * directement dans la webContents du processus principal.
 */
export function openBrowserWindow(targetUrl?: string): { ok: boolean; error?: string } {
  try {
    let page = 'browser.html'
    if (targetUrl) {
      if (!isHttpUrl(targetUrl)) {
        return { ok: false, error: 'URL refusee : seuls http et https sont acceptes.' }
      }
      page += '?url=' + encodeURIComponent(targetUrl)
    }

    const win = getOrCreateBrowserWindow()
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    if (devServerUrl) {
      const base = devServerUrl.endsWith('/') ? devServerUrl.slice(0, -1) : devServerUrl
      void win.loadURL(base + '/' + page)
    } else {
      void win.loadFile(join(__dirname, '../renderer/browser.html'), {
        search: targetUrl ? 'url=' + encodeURIComponent(targetUrl) : undefined,
      })
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function getOrCreateBrowserWindow(): BrowserWindow {
  if (browserWindow && !browserWindow.isDestroyed()) {
    if (browserWindow.isMinimized()) browserWindow.restore()
    browserWindow.focus()
    return browserWindow
  }

  // Enregistre le CSP elargi avant toute requete, sinon la premiere page de
  // confiance partirait avec le CSP global et l'iframe serait bloquee.
  browserSession()

  const { BrowserWindow } = require('electron') as typeof import('electron')
  const win = new BrowserWindow({
    title: 'Venari - Navigateur Assistant',
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Aucun pop-up : tout doit rester dans le cadre sandboxe de l'iframe.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // La webContents principale ne doit jamais quitter la page de confiance.
  // Le second argument de 'will-navigate' est l'URL de destination ; utiliser
  // webContents.getURL() ici testerait l'URL courante et laisserait passer
  // n'importe quelle redirection vers un site distant.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedShellUrl(url)) event.preventDefault()
  })

  win.on('closed', () => {
    browserWindow = null
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  browserWindow = win
  return win
}

export function registerBrowserIpc(): void {
  ipcMain.handle(IPC.BrowserOpen, async (_e, targetUrl?: string) => {
    return openBrowserWindow(typeof targetUrl === 'string' ? targetUrl : undefined)
  })

  ipcMain.handle(IPC.BrowserClose, async () => {
    if (browserWindow && !browserWindow.isDestroyed()) {
      browserWindow.close()
    }
    return { ok: true }
  })
}