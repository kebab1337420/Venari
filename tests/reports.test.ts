import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mockUserData = ''

vi.mock('electron', () => ({
  app: { getPath: () => mockUserData },
}))

import { listReports, readReport, reportsRoot, resolveReportPath } from '../src/main/services/reports'

let root: string

beforeEach(() => {
  mockUserData = mkdtempSync(join(tmpdir(), 'venari-reports-'))
  root = reportsRoot()
  mkdirSync(join(root, 'prog_a'), { recursive: true })
  mkdirSync(join(root, 'prog_b'), { recursive: true })
  writeFileSync(join(root, 'prog_a', '2026-01-01-xss.md'), '# XSS\n\nCorps du rapport.\n')
  writeFileSync(join(root, 'prog_a', 'notes.txt'), 'ignore-moi')
  writeFileSync(join(root, 'prog_b', '2026-02-01-idor.md'), '# IDOR\n')
  writeFileSync(join(mockUserData, 'secret.md'), 'secret hors dossier')
})

afterEach(() => {
  rmSync(mockUserData, { recursive: true, force: true })
})

describe('reports', () => {
  it('liste uniquement les Markdown, un niveau de dossiers', () => {
    const reports = listReports()
    expect(reports).toHaveLength(2)
    expect(reports.map((r) => r.path).sort()).toEqual([
      'prog_a/2026-01-01-xss.md',
      'prog_b/2026-02-01-idor.md',
    ])
    expect(reports.every((r) => r.name.endsWith('.md'))).toBe(true)
    expect(reports[0]!.size).toBeGreaterThan(0)
  })

  it('lit un rapport du dossier', () => {
    const res = readReport('prog_a/2026-01-01-xss.md')
    expect(res).toMatchObject({ ok: true, truncated: false })
    if (res.ok) expect(res.content).toContain('Corps du rapport')
  })

  it('refuse les traversals et les chemins absolus', () => {
    expect(resolveReportPath('../secret.md')).toBeNull()
    expect(resolveReportPath('prog_a/../../secret.md')).toBeNull()
    expect(resolveReportPath('C:/Windows/win.ini')).toBeNull()
    expect(resolveReportPath('/etc/passwd')).toBeNull()
    expect(readReport('../secret.md')).toMatchObject({ ok: false })
    expect(readReport('prog_a/notes.txt')).toMatchObject({ ok: false })
    expect(readReport('prog_a/inconnu.md')).toMatchObject({ ok: false })
  })

  it('renvoie une liste vide si le dossier n existe pas', () => {
    rmSync(root, { recursive: true, force: true })
    expect(listReports()).toEqual([])
    expect(readReport('prog_a/2026-01-01-xss.md')).toMatchObject({ ok: false })
  })
})
