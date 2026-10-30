import { app, BrowserWindow } from 'electron'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'path'
import { restoreToken } from './app-state'
import { registerIpc } from './ipc'
import { registerProgramsIpc } from './ipc-programs'
import { registerDetailIpc } from './ipc-detail'
import { registerScanIpc } from './ipc-scan'
import { registerToolsIpc } from './ipc-tools'
import { registerMcpIpc, restoreAutostartMcp } from './ipc-mcp'
import { registerBrowserIpc } from './ipc-browser'
import { registerReportsIpc } from './ipc-reports'
import { installSecurity } from './security'
import { closeDb, getRepository } from './db'
import { purgeInstallResidues } from './services/tools/installer'
import { setMainWindow } from './window'

const APP_ID = 'com.venari.app'

// Avant le renommage BountyDesk -> Venari, les donnees (config.json,
// bountydesk.db, tools/) vivaient dans %APPDATA%\BountyDesk. Le productName
// etant desormais Venari, Electron pointe vers un nouveau dossier : on
// deplace l'ancien une seule fois, si le nouveau est encore vide d'existence.
function migrateLegacyUserData(): void {
  try {
    const legacy = join(app.getPath('appData'), 'BountyDesk')
    const current = app.getPath('userData')
    if (legacy.toLowerCase() === current.toLowerCase()) return
    if (existsSync(legacy) && !existsSync(current)) {
      renameSync(legacy, current)
      console.log(`Venari : donnees migratees de ${legacy} vers ${current}`)
    }
  } catch (err) {
    console.error(`Venari : migration du dossier de donnees impossible (${err}) — on continue avec ${app.getPath('userData')}`)
  }
}

let mainWindow: BrowserWindow | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.show()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    migrateLegacyUserData()
    app.setAppUserModelId(APP_ID)
    installSecurity()
    restoreToken()
    registerIpc()
    registerProgramsIpc()
    registerDetailIpc()
    registerScanIpc()
    registerToolsIpc()
    registerMcpIpc()
    restoreAutostartMcp()
    registerBrowserIpc()
    registerReportsIpc()
    purgeInstallResidues()
    // Un scan "running" datant d'un arrêt précédent ne peut plus progresser :
    // on le referme en erreur pour que l'UI cesse de l'attendre.
    getRepository().failOrphanScans()
    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // Fermeture propre : SQLite referme son WAL (checkpoint final) au lieu d'être
  // tué en pleine écriture par la fin du processus.
  app.on('before-quit', () => {
    closeDb()
  })

  // Un renderer qui plante ne doit pas laisser une fenêtre blanche : on
  // recharge, mais sans boucler si le crash se répète.
  let rendererReloads = 0
  let rendererReloadWindow = 0
  app.on('render-process-gone', (_event, contents, details) => {
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    if (now - rendererReloadWindow > 30_000) {
      rendererReloadWindow = now
      rendererReloads = 0
    }
    if (rendererReloads >= 3) {
      console.error(`Venari : renderer disparu (${details.reason}) — rechargements multiples, abandon.`)
      return
    }
    rendererReloads += 1
    console.error(`Venari : renderer disparu (${details.reason}) — rechargement.`)
    contents.reload()
  })
}

function createWindow(): BrowserWindow {
  // En dev l'icône vient du dépôt ; empaquetée elle est portée par l'exécutable.
  const windowIcon = join(app.getAppPath(), 'build', 'icon.ico')
  const window = new BrowserWindow({
    title: 'Venari',
    icon: existsSync(windowIcon) ? windowIcon : undefined,
    width: 1120,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  setMainWindow(window)
  window.on('closed', () => {
    setMainWindow(null)
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}