import { dialog, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { z } from 'zod'
import { IPC } from '../shared/ipc'
import { getRepository } from './db'
import { getClient } from './app-state'
import { syncPrograms } from './services/programs'
import { exportFileName, exportQuery, serializeExport } from './services/export'

const programIdSchema = z.string().min(1).max(200)
const dbResultError = (err: unknown): { ok: false; error: string } => ({
  ok: false,
  error: err instanceof Error ? err.message : String(err),
})

const programsQuerySchema = z.object({
  search: z.string().max(500).optional(),
  favoriteOnly: z.boolean().optional(),
  groupId: z.number().int().positive().optional(),
  tagId: z.number().int().positive().optional(),
  sort: z.enum(['name', 'bounty', 'recent']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
})

/**
 * L'export ignore la pagination (on exporte ce qui est filtré, pas ce qui est
 * déroulé) : sa validation n'accepte donc ni limit ni offset.
 */
const programsExportSchema = programsQuerySchema
  .omit({ limit: true, offset: true })
  .extend({ format: z.enum(['csv', 'json', 'md']) })

export function registerProgramsIpc(): void {
  ipcMain.handle(IPC.ProgramsList, (_event, rawQuery) => {
    const query = programsQuerySchema.parse(rawQuery ?? {})
    const repo = getRepository()
    return repo.listPrograms(query)
  })

  ipcMain.handle(IPC.ProgramsSync, async () => {
    const client = getClient()
    if (!client.getToken()) return { ok: false, error: 'Aucun token configuré' } as const
    const synced = await syncPrograms(client)
    return { ok: true, synced, at: Date.now() } as const
  })

  ipcMain.handle(IPC.ProgramsExport, async (_event, rawQuery) => {
    const parsed = programsExportSchema.safeParse(rawQuery ?? {})
    if (!parsed.success) {
      return { ok: false, error: "Paramètres d'export invalides." } as const
    }
    const { format, ...filters } = parsed.data
    const { records } = getRepository().listPrograms(exportQuery(filters))
    if (records.length === 0) {
      return { ok: false, error: 'Aucun programme à exporter avec ces filtres.' } as const
    }
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Exporter les programmes',
      defaultPath: exportFileName(format),
      filters:
        format === 'csv'
          ? [{ name: 'CSV (UTF-8)', extensions: ['csv'] }]
          : format === 'json'
            ? [{ name: 'JSON', extensions: ['json'] }]
            : [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (canceled || !filePath) {
      return { ok: false, error: 'Export annulé.', canceled: true } as const
    }
    try {
      writeFileSync(filePath, serializeExport(records, format), 'utf8')
    } catch (err) {
      return dbResultError(err)
    }
    return { ok: true, path: filePath, rows: records.length } as const
  })

  ipcMain.handle(IPC.FavoriteSet, (_event, raw) => {
    const repo = getRepository()
    try {
      const { programId, favorite } = z
        .object({ programId: programIdSchema, favorite: z.boolean() })
        .parse(raw)
      repo.setFavorite(programId, favorite)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.NoteSet, (_event, raw) => {
    const repo = getRepository()
    try {
      const { programId, note } = z
        .object({ programId: programIdSchema, note: z.string().max(20_000) })
        .parse(raw)
      repo.setNote(programId, note)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.GroupsList, () => getRepository().listGroups())

  ipcMain.handle(IPC.GroupsCreate, (_event, rawName) => {
    const repo = getRepository()
    try {
      const name = z.string().trim().min(1).max(100).parse(rawName)
      return { ok: true, group: repo.createGroup(name) } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.GroupsRename, (_event, raw) => {
    const repo = getRepository()
    try {
      const { id, name } = z
        .object({ id: z.number().int().positive(), name: z.string().trim().min(1).max(100) })
        .parse(raw)
      repo.renameGroup(id, name)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.GroupsRemove, (_event, rawId) => {
    const repo = getRepository()
    try {
      const id = z.number().int().positive().parse(rawId)
      repo.removeGroup(id)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.GroupsAddMember, (_event, raw) => {
    const repo = getRepository()
    try {
      const { groupId, programId } = z
        .object({ groupId: z.number().int().positive(), programId: programIdSchema })
        .parse(raw)
      repo.addToGroup(groupId, programId)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.GroupsRemoveMember, (_event, raw) => {
    const repo = getRepository()
    try {
      const { groupId, programId } = z
        .object({ groupId: z.number().int().positive(), programId: programIdSchema })
        .parse(raw)
      repo.removeFromGroup(groupId, programId)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.TagsList, () => getRepository().listTags())

  ipcMain.handle(IPC.TagsCreate, (_event, rawName) => {
    const repo = getRepository()
    try {
      const name = z.string().trim().min(1).max(50).parse(rawName)
      return { ok: true, tag: repo.createTag(name) } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.TagsRemove, (_event, rawId) => {
    const repo = getRepository()
    try {
      const id = z.number().int().positive().parse(rawId)
      repo.removeTag(id)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.TagsAddToProgram, (_event, raw) => {
    const repo = getRepository()
    try {
      const { programId, tagId } = z
        .object({ programId: programIdSchema, tagId: z.number().int().positive() })
        .parse(raw)
      repo.addTagToProgram(programId, tagId)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.TagsRemoveFromProgram, (_event, raw) => {
    const repo = getRepository()
    try {
      const { programId, tagId } = z
        .object({ programId: programIdSchema, tagId: z.number().int().positive() })
        .parse(raw)
      repo.removeTagFromProgram(programId, tagId)
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })
}