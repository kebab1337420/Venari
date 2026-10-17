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

const labelSchema = z.string().trim().min(1).max(200)
const usernameSchema = z.string().max(1000)
const secretSchema = z.string().max(10000)
const noteSchema = z.string().max(5000)

const credentialInputSchema = z.object({
  programId: programIdSchema,
  label: labelSchema,
  username: usernameSchema.default(''),
  secret: secretSchema.default(''),
  note: noteSchema.default(''),
})

// Patch volontairement SANS `.default('')` : un champ omis doit rester `undefined`
// (donc inchangé en base). `credentialInputSchema.partial()` appliquait quand même les
// défauts et écrasait username/note par '' lors d'une mise à jour partielle, alors que
// le service protège déjà explicitement `secret` sur ce même principe (un champ omis
// ne doit jamais écraser la valeur stockée).
const credentialPatchSchema = z.object({
  label: labelSchema.optional(),
  username: usernameSchema.optional(),
  secret: secretSchema.optional(),
  note: noteSchema.optional(),
})

const dbResultError = (err: unknown): { ok: false; error: string } => ({
  ok: false,
  error: err instanceof Error ? err.message : String(err),
})

export function registerDetailIpc(): void {
  ipcMain.handle(IPC.ProgramDetailGet, async (_event, rawId) => {
    const client = getClient()
    try {
      const programId = programIdSchema.parse(rawId)
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
    try {
      const programId = programIdSchema.parse(rawId)
      return { ok: true, credentials: listCredentials(programId) } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  // Le secret n'est renvoye que pour la ligne que l'utilisateur a choisi de reveler.
  ipcMain.handle(IPC.CredentialsReveal, (_event, rawId) => {
    try {
      const id = z.number().int().min(1).parse(rawId)
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
    try {
      const input = credentialInputSchema.parse(raw)
      return { ok: true, id: addCredential(input) } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.CredentialsUpdate, (_event, raw) => {
    try {
      const { id, patch } = z
        .object({
          id: credentialIdSchema,
          patch: credentialPatchSchema,
        })
        .parse(raw)
      updateCredentialPatch(id, patch)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.CredentialsRemove, (_event, rawId) => {
    try {
      const id = credentialIdSchema.parse(rawId)
      removeCredential(id)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.OpenExternal, async (_event, rawUrl) => {
    try {
      const url = z.string().url().parse(rawUrl)
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