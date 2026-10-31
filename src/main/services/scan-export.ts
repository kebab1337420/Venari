import type { ExportFormat, ScanOverview } from '../../shared/ipc'
import { csvCell } from './export'

export const SCAN_EXPORT_COLUMNS = [
  'id',
  'program_id',
  'program_name',
  'program_handle',
  'depth',
  'status',
  'rate_limit',
  'roe_confirm',
  'started_at',
  'finished_at',
] as const

function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function scanExportRow(s: ScanOverview): Array<string | number | boolean | null> {
  return [
    s.id,
    s.programId,
    s.programName,
    s.programHandle,
    s.depth,
    s.status,
    s.rateLimit,
    s.roeConfirm,
    new Date(s.startedAt).toISOString(),
    s.finishedAt ? new Date(s.finishedAt).toISOString() : '',
  ]
}

export function scanToCsv(records: ScanOverview[]): string {
  const lines = [SCAN_EXPORT_COLUMNS.join(',')]
  for (const s of records) {
    lines.push(scanExportRow(s).map(csvCell).join(','))
  }
  return `\ufeff${lines.join('\r\n')}\r\n`
}

export function scanToJson(records: ScanOverview[]): string {
  return `${JSON.stringify(records, null, 2)}\n`
}

export function scanToMarkdown(records: ScanOverview[]): string {
  const header = `| ${SCAN_EXPORT_COLUMNS.join(' | ')} |`
  const separator = `| ${SCAN_EXPORT_COLUMNS.map(() => '---').join(' | ')} |`
  const rows = records.map((s) => `| ${scanExportRow(s).map((v) => mdCell(String(v ?? ''))).join(' | ')} |`)
  return `${[header, separator, ...rows].join('\n')}\n`
}

export function serializeScanExport(records: ScanOverview[], format: ExportFormat): string {
  if (format === 'json') return scanToJson(records)
  if (format === 'md') return scanToMarkdown(records)
  return scanToCsv(records)
}

export function scanExportFileName(format: ExportFormat, at: number = Date.now()): string {
  const day = new Date(at).toISOString().slice(0, 10)
  return `venari-scans-${day}.${format}`
}
