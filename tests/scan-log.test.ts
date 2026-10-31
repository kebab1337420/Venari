// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ScanEvent } from '../src/shared/ipc'
import { formatScanLog, scanLogFileName, type ScanLogMeta } from '../src/main/services/scan/scan-log'

const meta = (over: Partial<ScanLogMeta> = {}): ScanLogMeta => ({
  id: 12,
  programName: 'Acme Corp',
  programHandle: 'acme',
  depth: 'med',
  status: 'done',
  rateLimit: 5,
  startedAt: 1_000,
  finishedAt: 61_000,
  ...over
})

const event = (over: Partial<ScanEvent> = {}): ScanEvent => ({
  seq: 1,
  ts: 2_000,
  level: 'info',
  message: 'scan demarre',
  ...over
})

describe('scanLogFileName', () => {
  it('derive un nom sur depuis le handle', () => {
    expect(scanLogFileName(meta())).toBe('scan-12-acme.txt')
  })

  it('remplace les caracteres interdits et retombe sur le nom du programme', () => {
    expect(scanLogFileName({ id: 3, programName: 'Acme / Corp: *FR*', programHandle: '' })).toBe(
      'scan-3-acme-corp-fr.txt'
    )
  })

  it('a un repli quand tout est vide', () => {
    expect(scanLogFileName({ id: 4, programName: '   ', programHandle: '' })).toBe('scan-4-programme.txt')
  })
})

describe('formatScanLog', () => {
  it('produit un en-tete lisible et une ligne horodatee par evenement', () => {
    const text = formatScanLog(meta(), [event(), event({ seq: 2, ts: 3_000, level: 'error', message: 'echec' })])
    const lines = text.split('\n')
    expect(lines[0]).toBe('# Venari - journal de scan')
    expect(lines[1]).toBe('Programme : Acme Corp (@acme)')
    expect(lines[2]).toBe('Scan #12 - profondeur med - statut done - 5 req/s')
    expect(lines[3]).toBe('Debut : 1970-01-01T00:00:01.000Z')
    expect(lines[4]).toBe('Fin : 1970-01-01T00:01:01.000Z')
    expect(lines[5]).toBe('Evenements : 2')
    expect(text).toContain('[1970-01-01T00:00:02.000Z] [info] scan demarre')
    expect(text).toContain('[1970-01-01T00:00:03.000Z] [error] echec')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('indique un scan encore en cours et gere un journal vide', () => {
    const text = formatScanLog(meta({ finishedAt: null, status: 'running' }), [])
    expect(text).toContain('Fin : en cours')
    expect(text).toContain('Evenements : 0')
  })

  it('omet le handle quand il est absent', () => {
    expect(formatScanLog(meta({ programHandle: '' }), [])).toContain('Programme : Acme Corp\n')
  })
})
