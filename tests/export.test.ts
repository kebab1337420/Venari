import { describe, it, expect } from 'vitest'
import type { ProgramSummary } from '../src/shared/ipc'
import {
  EXPORT_COLUMNS,
  EXPORT_MAX_ROWS,
  csvCell,
  exportFileName,
  exportQuery,
  programExportRow,
  serializeExport,
  toCsv,
} from '../src/main/services/export'

function program(overrides: Partial<ProgramSummary> = {}): ProgramSummary {
  return {
    id: 'prog-1',
    handle: 'acme',
    name: 'Acme Corp',
    type: 'public',
    status: 'active',
    confidentiality: 'public',
    minBounty: { value: 100, currency: 'EUR' },
    maxBounty: { value: 5000, currency: 'EUR' },
    industry: 'Software',
    webLink: 'https://acme.example',
    following: true,
    favorite: true,
    note: 'scope: *.acme.example',
    tags: ['api', 'nofollow'],
    groups: ['Mobile'],
    updatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    ...overrides,
  }
}

describe('csvCell', () => {
  it('échappe les virgules, guillemets et retours à la ligne', () => {
    expect(csvCell('simple')).toBe('simple')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('ligne1\nligne2')).toBe('"ligne1\nligne2"')
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell(true)).toBe('true')
    expect(csvCell(42)).toBe('42')
  })

  it('neutralise les formules injectées depuis une note ou un handle', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)")
    expect(csvCell('+1+1')).toBe("'+1+1")
    expect(csvCell('-1+1')).toBe("'-1+1")
    expect(csvCell('@cmd')).toBe("'@cmd")
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe('"\'=HYPERLINK(""http://evil"",""x"")"')
  })
})

describe('toCsv', () => {
  it('commence par un BOM et une ligne d’en-tête, puis une ligne par programme', () => {
    const csv = toCsv([program()])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).split('\r\n')
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(','))
    expect(lines[1]).toContain('Acme Corp')
    expect(lines[1]).toContain('5000,EUR')
    // 1ère ligne d'en-tête + 1 programme + ligne vide finale
    expect(lines.at(-1)).toBe('')

    const quoted = toCsv([program({ name: 'Acme, Inc' })])
    expect(quoted).toContain('"Acme, Inc"')
  })

  it('refait la ligne complète avec les champs attendus', () => {
    const row = programExportRow(program())
    expect(EXPORT_COLUMNS).toHaveLength(row.length)
    expect(row).toContain('prog-1')
    expect(row).toContain('api | nofollow')
    expect(row).toContain('Mobile')
    expect(row).toContain('2026-01-02T03:04:05.000Z')
    expect(row).toContain('5000')
  })

  it('porte les métadonnées locales (favori, note) qui ne sont pas dans l’API', () => {
    const csv = toCsv([program({ favorite: true, note: '=attention' })])
    expect(csv).toContain("'=attention")
    expect(csv).toContain(',true,')
  })
})

describe('serializeExport', () => {
  it('produit du JSON parseable qui garde les mêmes données', () => {
    const records = [program()]
    const parsed = JSON.parse(serializeExport(records, 'json')) as ProgramSummary[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.id).toBe('prog-1')
    expect(parsed[0]!.tags).toEqual(['api', 'nofollow'])
  })

  it('produit du Markdown avec en-tête, separateur et cellules echappees', () => {
    const md = serializeExport([program({ name: 'Acme|Corp', note: 'l1\nl2' })], 'md')
    expect(md).toContain('| id | handle | name')
    expect(md).toContain('| --- |')
    expect(md).toContain('Acme\\|Corp')
    expect(md).toContain('l1 l2')
  })

  it('choisit le bon format', () => {
    expect(serializeExport([], 'csv')).toContain(EXPORT_COLUMNS.join(','))
    expect(serializeExport([], 'json')).toBe('[]\n')
    expect(serializeExport([], 'md')).toContain('| id |')
  })
})

describe('exportFileName / exportQuery', () => {
  it('nomme le fichier avec la date du jour et le format', () => {
    expect(exportFileName('csv', Date.UTC(2026, 5, 17))).toBe('venari-programmes-2026-06-17.csv')
    expect(exportFileName('json', Date.UTC(2026, 5, 17))).toBe('venari-programmes-2026-06-17.json')
    expect(exportFileName('md', Date.UTC(2026, 5, 17))).toBe('venari-programmes-2026-06-17.md')
  })

  it('exporte tout ce qui est filtré, sans pagination', () => {
    const q = exportQuery({ search: 'acme', favoriteOnly: true, limit: 200, offset: 400 })
    expect(q).toEqual({ search: 'acme', favoriteOnly: true, limit: EXPORT_MAX_ROWS, offset: 0 })
  })
})
