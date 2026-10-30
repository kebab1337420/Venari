import { app } from 'electron'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { ReportEntry } from '../../shared/ipc'

/** Un rapport est un Markdown court ; au-dela on tronque plutot que de figer le renderer. */
export const MAX_REPORT_BYTES = 512 * 1024

export function reportsRoot(): string {
  return join(app.getPath('userData'), 'reports')
}

/**
 * Le renderer ne manipule que des chemins relatifs a `userData/reports`
 * (`<programId>/<fichier>.md`). Tout chemin absolu ou remontant est refuse :
 * sans ce verrou, un `read` ou un `openFolder` pouvait viser n'importe quel
 * fichier de la machine.
 */
export function resolveReportPath(relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return null
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return null
  if (normalized.split('/').some((part) => part === '..' || part === '')) return null
  const root = resolve(reportsRoot())
  const full = resolve(root, normalized)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

/**
 * Un niveau de dossiers (un par programme), comme `submit_report` les ecrit.
 * Les fichiers parasites (sous-dossiers, non-Markdown) sont ignores.
 */
export function listReports(): ReportEntry[] {
  const root = reportsRoot()
  let programDirs: string[]
  try {
    programDirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const out: ReportEntry[] = []
  for (const programId of programDirs) {
    let files: string[]
    try {
      files = readdirSync(join(root, programId), { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.toLowerCase().endsWith('.md'))
        .map((f) => f.name)
    } catch {
      continue
    }
    for (const name of files) {
      try {
        const st = statSync(join(root, programId, name))
        out.push({
          programId,
          relativePath: `${programId}/${name}`,
          name,
          size: st.size,
          mtime: st.mtimeMs,
        })
      } catch {
        /* fichier supprime entre le readdir et le stat */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

export function readReport(relativePath: string): { ok: true; content: string; truncated: boolean } | { ok: false; error: string } {
  const full = resolveReportPath(relativePath)
  if (!full || !full.toLowerCase().endsWith('.md')) return { ok: false, error: 'Chemin de rapport invalide' }
  try {
    const st = statSync(full)
    if (!st.isFile()) return { ok: false, error: 'Rapport introuvable' }
    const buf = readFileSync(full)
    const truncated = buf.length > MAX_REPORT_BYTES
    return { ok: true, content: buf.subarray(0, MAX_REPORT_BYTES).toString('utf8'), truncated }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
