import type { ScanEvent } from '../../../shared/ipc'

export interface ScanLogMeta {
  id: number
  programName: string
  programHandle: string
  depth: string
  status: string
  rateLimit: number
  startedAt: number
  finishedAt: number | null
}

/**
 * Nom de fichier propose au selecteur : le handle vient de l'API, donc on le
 * reduit a [a-z0-9._-] pour ne jamais produire de nom invalide (Windows refuse
 * `:*?"<>|` et les espaces finaux).
 */
export function scanLogFileName(meta: Pick<ScanLogMeta, 'id' | 'programName' | 'programHandle'>): string {
  const raw = (meta.programHandle || meta.programName).trim().toLowerCase()
  const slug = raw
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  return `scan-${meta.id}-${slug || 'programme'}.txt`
}

function iso(ts: number): string {
  return new Date(ts).toISOString()
}

/**
 * Journal autonome : en-tete lisible (programme, profondeur, bornes) puis une
 * ligne horodatee par evenement. Aucun secret n'y figure : le runner ne
 * journalise que ses propres messages.
 */
export function formatScanLog(meta: ScanLogMeta, events: ScanEvent[]): string {
  const lines = [
    '# Venari - journal de scan',
    `Programme : ${meta.programName}${meta.programHandle ? ` (@${meta.programHandle})` : ''}`,
    `Scan #${meta.id} - profondeur ${meta.depth} - statut ${meta.status} - ${meta.rateLimit} req/s`,
    `Debut : ${iso(meta.startedAt)}`,
    `Fin : ${meta.finishedAt === null ? 'en cours' : iso(meta.finishedAt)}`,
    `Evenements : ${events.length}`,
    '',
  ]
  for (const event of events) {
    lines.push(`[${iso(event.ts)}] [${event.level}] ${event.message}`)
  }
  return `${lines.join('\n')}\n`
}
