import type { ExportFormat, ProgramSummary, ProgramsQuery } from '../../shared/ipc'

/**
 * Export du catalogue local (programmes + métadonnées locales : favoris,
 * notes, tags, groupes). Tout est produit ici sous forme de chaîne : le
 * sérialiseur est pur, testable sans Electron, et le processus principal se
 * contente d'écrire le fichier choisi par l'utilisateur.
 */

export const EXPORT_COLUMNS = [
  'id',
  'handle',
  'name',
  'type',
  'status',
  'confidentiality',
  'min_bounty',
  'min_currency',
  'max_bounty',
  'max_currency',
  'industry',
  'web_link',
  'following',
  'favorite',
  'note',
  'tags',
  'groups',
  'updated_at',
] as const

/**
 * Un tableur interprète une cellule commençant par `=`, `+`, `-`, `@`, tab ou
 * retour à la ligne comme une formule : une note locale (ou un handle) suffit
 * alors à exécuter du code à l'ouverture du fichier. On force donc le texte.
 */
function guardFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  const raw = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
  const safe = guardFormula(raw)
  return /["\r\n,;\t]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

function money(value: number | null): string {
  return value === null ? '' : String(value)
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString()
}

export function programExportRow(p: ProgramSummary): Array<string | number | boolean | null> {
  return [
    p.id,
    p.handle,
    p.name,
    p.type,
    p.status,
    p.confidentiality,
    money(p.minBounty?.value ?? null),
    p.minBounty?.currency ?? '',
    money(p.maxBounty?.value ?? null),
    p.maxBounty?.currency ?? '',
    p.industry,
    p.webLink,
    p.following,
    p.favorite,
    p.note,
    p.tags.join(' | '),
    p.groups.join(' | '),
    isoDate(p.updatedAt),
  ]
}

/** CSV avec BOM (U+FEFF) : Excel ouvre alors UTF-8 sans régler quoi que ce soit. */
export function toCsv(records: ProgramSummary[]): string {
  const lines = [EXPORT_COLUMNS.join(',')]
  for (const p of records) {
    lines.push(programExportRow(p).map(csvCell).join(','))
  }
  return `\ufeff${lines.join('\r\n')}\r\n`
}

export function toJson(records: ProgramSummary[]): string {
  return `${JSON.stringify(records, null, 2)}\n`
}

/** Une cellule markdown ne doit pas casser le tableau : on échappe `|` et on
 * remplace les retours à la ligne, sinon la ligne du tableau est rompue. */
function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Tableau Markdown collable dans un rapport ou un ticket. */
export function toMarkdown(records: ProgramSummary[]): string {
  const header = `| ${EXPORT_COLUMNS.join(' | ')} |`
  const separator = `| ${EXPORT_COLUMNS.map(() => '---').join(' | ')} |`
  const rows = records.map((p) => `| ${programExportRow(p).map((v) => mdCell(String(v ?? ''))).join(' | ')} |`)
  return `${[header, separator, ...rows].join('\n')}\n`
}

export function serializeExport(records: ProgramSummary[], format: ExportFormat): string {
  if (format === 'json') return toJson(records)
  if (format === 'md') return toMarkdown(records)
  return toCsv(records)
}

export function exportFileName(format: ExportFormat, at: number = Date.now()): string {
  const day = new Date(at).toISOString().slice(0, 10)
  return `venari-programmes-${day}.${format}`
}

/**
 * L'export part des filtres courants, mais ignore la pagination : on veut ce
 * que l'utilisateur voit filtré, pas ce qu'il a pris la peine de dérouler.
 * Plafond défensif : le catalogue reste petit, inutile de produire un fichier
 * sans limite si la requête part dans un mur.
 */
export const EXPORT_MAX_ROWS = 100_000

export function exportQuery(query: ProgramsQuery): ProgramsQuery {
  const { limit: _limit, offset: _offset, ...rest } = query
  return { ...rest, limit: EXPORT_MAX_ROWS, offset: 0 }
}
