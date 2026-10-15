import { app, session, shell } from 'electron'
import { join, sep } from 'path'
import { fileURLToPath } from 'url'

/**
 * Dossier renderer servi en file:// une fois empaquete. Seule cette arborescence
 * est une destination de navigation legitime : le preload est attache a toute
 * page chargee par la webContents, donc un fichier local arbitraire recupererait
 * le pont `bountydesk` et avec lui run_tool / credentials / open_browser.
 */
function rendererRoot(): string {
  return join(__dirname, '../renderer')
}

/**
 * La forme `startsWith(base)` laisse passer `http://localhost:5173.evil.com` :
 * il faut le slash final pour que le test porte sur un sous-chemin reel.
 */
function isTrustedNavigation(rawUrl: string): boolean {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    const base = devServerUrl.endsWith('/') ? devServerUrl : devServerUrl + '/'
    return rawUrl === devServerUrl || rawUrl.startsWith(base)
  }
  if (!rawUrl.startsWith('file://')) return false
  try {
    const target = fileURLToPath(rawUrl)
    const root = rendererRoot()
    return target === root || target.startsWith(root + sep)
  } catch {
    return false
  }
}

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // blob: est necessaire a la fenetre de vue distante, qui affiche l'ecran du PC
  // recu en WebSocket via URL.createObjectURL. En dev la page est servie en
  // http://localhost (donc same-origin) et le joker 'self' suffisait ; une fois
  // empaquetee en file://, 'self' ne couvre pas blob: et l'image etait refusee.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ')

export function installSecurity(): void {
  const dev = !app.isPackaged
  const csp = dev
    ? PROD_CSP.replace("connect-src 'none'", "connect-src 'self' ws://localhost:*")
    : PROD_CSP

  // L'app n'a besoin d'aucun droit natif : on refuse tout par defaut plutot que
  // d'accorder ce qu'Electron accorde par defaut (micro, geo, notifications, USB, HID...).
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      if (!isTrustedNavigation(url)) {
        event.preventDefault()
      }
    })
  })
}