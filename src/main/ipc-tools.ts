import { ipcMain } from 'electron'
import { IPC, type DbResult, type GitHubTokenSetResult, type GitHubTokenStatusResult, type ToolInstallOutput, type ToolInstallResult, type ToolsListResult } from '../shared/ipc'
import { clearGithubToken, loadGithubToken, saveGithubToken } from './storage'
import { currentTools, installTool } from './services/tools/installer'

export function registerToolsIpc(): void {
  ipcMain.handle(IPC.ToolsList, async (): Promise<ToolsListResult> => {
    try {
      return { ok: true, tools: await currentTools() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.ToolsGitHubTokenGet, async (): Promise<GitHubTokenStatusResult> => {
    try {
      // `||` (et non `??`) : une variable d'environnement vide ou un jeton
      // stocké vide ne comptent pas comme une configuration.
      return { ok: true, configured: Boolean(process.env.GITHUB_TOKEN || loadGithubToken()) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.ToolsGitHubTokenSet, async (_event, raw: unknown): Promise<GitHubTokenSetResult> => {
    const token = typeof raw === 'string' ? raw.trim() : ''
    if (token.length < 1 || token.length > 200) {
      return { ok: false, error: 'Token GitHub invalide.' }
    }
    try {
      saveGithubToken(token)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.ToolsGitHubTokenClear, async (): Promise<DbResult> => {
    try {
      clearGithubToken()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.ToolsInstall, async (event, id: unknown): Promise<ToolInstallResult> => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 100) {
      return { ok: false, error: 'Identifiant d’outil invalide', output: '' }
    }
    const chunks: string[] = []
    // Sortie poussée au fil de l'eau : sans elle, l'utilisateur ne voit rien
    // pendant plusieurs minutes et croit l'installation bloquée.
    const out = (line: string) => {
      chunks.push(line)
      const wc = event.sender
      if (wc.isDestroyed()) return
      const payload: ToolInstallOutput = { id, line }
      wc.send(IPC.ToolsInstallOutput, payload)
    }
    const res = await installTool(id, out)
    if (res.ok) return { ok: true, installed: res.installed, output: chunks.join('') }
    return { ok: false, error: res.error, output: chunks.join('') }
  })
}