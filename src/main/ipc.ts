import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../shared/ipc'
import type { AuthRemoteHandlers } from './ipc-types'
import { clearTokenFromStore, hasToken, validateAndStoreToken } from './app-state'
import { usingSystemKeyring } from './storage'

const tokenSchema = z.string().min(10).max(500)

export function registerIpc(): void {
  ipcMain.handle(IPC.AuthStatus, async (): Promise<AuthRemoteHandlers['status']> => {
    return { configured: hasToken(), keyring: usingSystemKeyring() }
  })

  ipcMain.handle(IPC.AuthValidate, async (_event, raw: unknown): Promise<AuthRemoteHandlers['validate']> => {
    const parsed = tokenSchema.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, error: 'Format de token invalide.' }
    }
    return validateAndStoreToken(parsed.data)
  })

  ipcMain.handle(IPC.AuthClear, async (): Promise<void> => {
    clearTokenFromStore()
  })
}