import { app, ipcMain, shell } from 'electron'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { IPC, type ReportFile } from '../shared/ipc'

const segmentSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/)

const nameSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[^\\/]+\.md$/i)

const openPayload = z.object({ programId: segmentSchema, name: nameSchema })

const reportsRoot = (): string => join(app.getPath('userData'), 'reports')

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Le renderer ne fournit jamais un chemin, seulement un couple
 * (programme, fichier) : les deux segments sont restreints, donc `join` ne
 * peut pas sortir du dossier des rapports (pas de traversal).
 */
function resolveReport(raw: unknown): string {
  const { programId, name } = openPayload.parse(raw)
  if (programId === '.' || programId === '..') throw new Error('programme invalide')
  return join(reportsRoot(), programId, name)
}

async function listReports(): Promise<ReportFile[]> {
  const root = reportsRoot()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const reports: ReportFile[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.' || entry.name === '..') continue
    const dir = join(root, entry.name)
    let files
    try {
      files = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !/\.md$/i.test(file.name)) continue
      const full = join(dir, file.name)
      try {
        const st = await stat(full)
        reports.push({
          programId: entry.name,
          name: file.name,
          path: full,
          size: st.size,
          updatedAt: st.mtimeMs,
        })
      } catch {
        /* fichier disparu entre readdir et stat : on l'ignore */
      }
    }
  }

  reports.sort((a, b) => b.updatedAt - a.updatedAt)
  return reports.slice(0, 500)
}

export function registerReportsIpc(): void {
  ipcMain.handle(IPC.ReportsList, async () => {
    try {
      return { ok: true, reports: await listReports() } as const
    } catch (err) {
      return { ok: false, error: errorMessage(err) } as const
    }
  })

  ipcMain.handle(IPC.ReportsOpen, async (_event, raw) => {
    try {
      const error = await shell.openPath(resolveReport(raw))
      return error ? { ok: false, error } : { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  ipcMain.handle(IPC.ReportsReveal, (_event, raw) => {
    try {
      shell.showItemInFolder(resolveReport(raw))
      return { ok: true } as const
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
}
