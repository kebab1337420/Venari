import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  IPC,
  type FindingRecord,
  type FindingSeverity,
  type FindingStatus,
} from '../shared/ipc'
import { getRepository } from './db'
import type { FindingRow } from './db/repo'
import { listReports, readReport, resolveReportPath, reportsRoot } from './services/reports'

const programIdSchema = z.string().min(1).max(200)
const findingIdSchema = z.number().int().positive()
const reportPathSchema = z.string().max(1000).nullable()

const findingInputSchema = z.object({
  programId: programIdSchema,
  asset: z.string().max(500).default(''),
  title: z.string().trim().min(1).max(300),
  severity: z.enum(FINDING_SEVERITIES).default('info'),
  cvss: z.number().min(0).max(10).nullable().default(null),
  status: z.enum(FINDING_STATUSES).default('open'),
  description: z.string().max(50_000).default(''),
  poc: z.string().max(20_000).default(''),
  reportPath: reportPathSchema.default(null),
  scanId: z.number().int().positive().nullable().default(null),
})

const findingPatchSchema = findingInputSchema.omit({ programId: true }).partial()

const dbResultError = (err: unknown): { ok: false; error: string } => ({
  ok: false,
  error: err instanceof Error ? err.message : String(err),
})

function toRecord(row: FindingRow): FindingRecord {
  return {
    id: row.id,
    programId: row.program_id,
    programName: row.program_name,
    asset: row.asset,
    title: row.title,
    severity: row.severity as FindingSeverity,
    cvss: row.cvss,
    status: row.status as FindingStatus,
    description: row.description,
    poc: row.poc,
    reportPath: row.report_path,
    scanId: row.scan_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Valide qu'un chemin venu du renderer reste sous `userData/reports`.
 * Retourne `null` pour un chemin absent (pas de rapport lie).
 */
function safeReportPath(raw: string | null): string | null {
  if (raw === null) return null
  if (!resolveReportPath(raw)) throw new Error('Chemin de rapport invalide')
  return raw.replace(/\\/g, '/')
}

export function registerFindingsIpc(): void {
  ipcMain.handle(IPC.FindingsList, (_event, raw) => {
    try {
      const query = z
        .object({
          programId: programIdSchema.optional(),
          status: z.enum(FINDING_STATUSES).optional(),
          severity: z.enum(FINDING_SEVERITIES).optional(),
          search: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(500).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .default({})
        .parse(raw ?? {})
      return { ok: true, findings: getRepository().listFindings(query).map(toRecord) } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.FindingsStats, (_event, rawId) => {
    try {
      const programId = rawId === undefined || rawId === null ? undefined : programIdSchema.parse(rawId)
      return { ok: true, stats: getRepository().findingStats(programId) } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.FindingsCreate, (_event, raw) => {
    try {
      const input = findingInputSchema.parse(raw)
      if (!getRepository().getProgram(input.programId)) {
        return { ok: false, error: `Programme inconnu : ${input.programId}` } as const
      }
      const id = getRepository().createFinding({
        ...input,
        reportPath: safeReportPath(input.reportPath),
      })
      return { ok: true, id } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.FindingsUpdate, (_event, raw) => {
    try {
      const { id, patch } = z.object({ id: findingIdSchema, patch: findingPatchSchema }).parse(raw)
      const repo = getRepository()
      if (!repo.getFinding(id)) return { ok: false, error: `Finding introuvable (id=${id})` } as const
      repo.updateFinding(id, {
        ...patch,
        reportPath: patch.reportPath === undefined ? undefined : safeReportPath(patch.reportPath),
      })
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.FindingsRemove, (_event, rawId) => {
    try {
      getRepository().removeFinding(findingIdSchema.parse(rawId))
      return { ok: true } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.ReportsList, () => {
    try {
      return { ok: true, reports: listReports() } as const
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.ReportsRead, (_event, rawPath) => {
    try {
      const relativePath = z.string().min(1).max(1000).parse(rawPath)
      const res = readReport(relativePath)
      return res.ok
        ? ({ ok: true, content: res.content, truncated: res.truncated } as const)
        : ({ ok: false, error: res.error } as const)
    } catch (err) {
      return dbResultError(err)
    }
  })

  ipcMain.handle(IPC.ReportsOpenFolder, async (_event, rawPath) => {
    try {
      if (rawPath === undefined || rawPath === null) {
        const err = await shell.openPath(reportsRoot())
        return err ? { ok: false, error: err } : { ok: true }
      }
      const full = resolveReportPath(z.string().min(1).max(1000).parse(rawPath))
      if (!full) return { ok: false, error: 'Chemin de rapport invalide' }
      shell.showItemInFolder(full)
      return { ok: true }
    } catch (err) {
      return dbResultError(err)
    }
  })
}
