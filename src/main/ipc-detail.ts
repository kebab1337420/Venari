import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { IPC } from '../shared/ipc'
import { getClient } from './app-state'
import { fetchProgramDetail, getCachedProgramDetail } from './services/program-detail'
import {
  addCredential,
  listCredentials,
  removeCredential,
  revealCredentialSecret,
  updateCredentialPatch,
} from './services/credentials'

const programIdSchema = z.string().min(1).max(200)
const credentialIdSchema = z.number().int().positive()

const credentialInputSchema = z.object({
  programId: programIdSchema,
  label: z.string().trim().min(1).max(200),
  username: z.string().max(1000).default(''),
  secret: z.string().max(10000).default(''),
  note: z.string().max(5000).default(''),
})

const dbResultError = (err: unknown): { ok: false; error: string } => ({
  ok: false,
  error: err instanceof Error ? err.message : String(err),
})

export function registerDetailIpc(): void {
  ipcMain.handle(IPC.ProgramDetailGet, async (_event, rawId) => {
    const programId = programIdSchema.parse(rawId)
    const client = getClient()
    try {
      if (client.getToken()) {
        return { ok: true, detail: await fetchProgramDetail(client, programId) } as const
      }
      const cached = getCachedProgramDetail(programId)
      if (cached) return { ok: true, detail: cached } as const
      return { ok: false, error: 'Aucun token configuré ni cache disponible' } as const
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) } as const
    }
  })

  ipcMain.handle(IPC.CredentialsList, (_event, rawId) => {
    const programId = programIdSchema.parse(rawId)
    try {
      return { ok: true, credentials: listCredentials(programId) } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  // Le secret n'est renvoye que pour la ligne que l'utilisateur a choisi de reveler.
  ipcMain.handle(IPC.CredentialsReveal, (_event, rawId) => {
    const id = z.number().int().min(1).parse(rawId)
    try {
      const secret = revealCredentialSecret(id)
      if (secret === null) {
        return {
          ok: false,
          error: 'Secret illisible : déchiffrement impossible (clé ou chiffrement du système indisponible).',
        } as const
      }
      return { ok: true, secret } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.CredentialsAdd, (_event, raw) => {
    const input = credentialInputSchema.parse(raw)
    try {
      return { ok: true, id: addCredential(input) } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.CredentialsUpdate, (_event, raw) => {
    const { id, patch } = z
      .object({
        id: credentialIdSchema,
        patch: credentialInputSchema.partial().omit({ programId: true }),
      })
      .parse(raw)
    try {
      updateCredentialPatch(id, patch)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.CredentialsRemove, (_event, rawId) => {
    const id = credentialIdSchema.parse(rawId)
    try {
      removeCredential(id)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.OpenExternal, async (_event, rawUrl) => {
    const url = z.string().url().parse(rawUrl)
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return { ok: false, error: 'Protocole non autorisé' } as const
      }
      await shell.openExternal(u.toString())
      return { ok: true } as const
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) } as const
    }
  })
}