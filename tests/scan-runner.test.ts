import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'bountydesk-scan-'))
const workDir = mkdtempSync(join(tmpdir(), 'bountydesk-scanwork-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { handle: vi.fn() },
}))

import { closeDb, getRepository } from '../src/main/db'
import type { ProgramInput } from '../src/main/db/repo'
import { ScanRunner, type ScanRunnerOptions } from '../src/main/services/scan/runner'
import type { ScanPlan } from '../src/main/services/scan/plan'

const PROGRAM: ProgramInput = {
  id: 'prog-1',
  handle: 'acme',
  name: 'Acme',
  type: 'bug_bounty',
  status: 'active',
  confidentiality: 'public',
  minBounty: null,
  maxBounty: null,
  industry: null,
  webLink: null,
  following: false,
  rawJson: null,
}

function newScan(): number {
  const repo = getRepository()
  repo.upsertPrograms([PROGRAM])
  return repo.createScan({ programId: 'prog-1', depth: 'med', rateLimit: 20, roeConfirm: true })
}

function plan(steps: { tool: string; args: string[] }[]): ScanPlan {
  return {
    depth: 'med',
    rateLimit: 20,
    targets: ['127.0.0.1'],
    steps: steps.map((s) => ({ ...s, hint: 'test' })),
    userAgent: 'test',
  }
}

function events(scanId: number): string[] {
  return getRepository()
    .listScanEvents(scanId, 0, 2000)
    .map((e) => e.message)
}

function scanStatus(scanId: number): string {
  return getRepository().getScan(scanId)?.status ?? ''
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  closeDb()
  for (const f of ['bountydesk.db', 'bountydesk.db-wal', 'bountydesk.db-shm']) {
    rmSync(join(userData, f), { force: true })
  }
})

afterAll(() => {
  closeDb()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

describe('ScanRunner - plafond par etape', () => {
  it('arrete un outil qui ne rend jamais la main et le dit', async () => {
    const scanId = newScan()
    const runner = new ScanRunner(scanId, { stepTimeoutMs: 1500 })
    const started = Date.now()
    await runner.run(plan([{ tool: 'node', args: ['-e', 'setTimeout(() => {}, 600000)'] }]))
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(30_000)
    expect(events(scanId).some((m) => m.includes('délai de 2 s dépassé'))).toBe(true)
    expect(events(scanId).some((m) => m.includes('Aucun outil n’a rendu de résultat'))).toBe(true)
    expect(scanStatus(scanId)).toBe('error')
  }, 40_000)

  it('ne compte pas une etape arretee comme un outil ayant tourne', async () => {
    const scanId = newScan()
    const runner = new ScanRunner(scanId, { stepTimeoutMs: 1500 })
    await runner.run(
      plan([
        { tool: 'node', args: ['-e', 'setTimeout(() => {}, 600000)'] },
        { tool: 'node', args: ['-e', 'console.log("cette etape passe")'] }
      ])
    )
    const messages = events(scanId)
    expect(messages.some((m) => m.includes('cette etape passe'))).toBe(true)
    expect(messages.some((m) => m.includes('binaire introuvable'))).toBe(false)
    // Une etape a rendu, une autre a expire : le scan est termine, pas en erreur.
    expect(scanStatus(scanId)).toBe('done')
    expect(messages.some((m) => m.includes('étape(s) arrêtées au plafond'))).toBe(true)
  }, 40_000)

  it('signale un binaire absent comme absent, pas comme un delai depasse', async () => {
    const scanId = newScan()
    const runner = new ScanRunner(scanId, { stepTimeoutMs: 5000 })
    await runner.run(plan([{ tool: 'outil-qui-nexiste-pas-9999', args: [] }]))
    const messages = events(scanId)
    expect(messages.some((m) => m.includes('binaire introuvable'))).toBe(true)
    expect(messages.some((m) => m.includes('délai de'))).toBe(false)
    expect(scanStatus(scanId)).toBe('error')
  }, 30_000)
})

describe('ScanRunner - plafond d evenements', () => {
  it('coupe un flux bavard et annonce la troncature', async () => {
    const scanId = newScan()
    const runner = new ScanRunner(scanId, { stepTimeoutMs: 20_000, maxEvents: 5 } as ScanRunnerOptions)
    const script = 'for (let i = 0; i < 200; i++) console.log("ligne " + i)'
    await runner.run(plan([{ tool: 'node', args: ['-e', script] }]))

    const messages = events(scanId)
    expect(messages.filter((m) => m.startsWith('ligne ')).length).toBeLessThanOrEqual(5)
    expect(messages.some((m) => m.includes('Flux tronqué'))).toBe(true)
  }, 40_000)

  it('ecrit l avis de troncature avant la mise a jour du statut', async () => {
    const scanId = newScan()
    const repo = getRepository()
    const order: string[] = []
    const origAppend = repo.appendScanEvent.bind(repo)
    const origUpdate = repo.updateScan.bind(repo)
    vi.spyOn(repo, 'appendScanEvent').mockImplementation((id, seq, level, message, ts) => {
      origAppend(id, seq, level, message, ts)
      if (message.includes('Flux tronqué')) order.push('truncation')
    })
    vi.spyOn(repo, 'updateScan').mockImplementation((id, patch) => {
      origUpdate(id, patch)
      if (patch.status) order.push(`status:${patch.status}`)
    })

    const runner = new ScanRunner(scanId, { stepTimeoutMs: 20_000, maxEvents: 5 })
    const script = 'for (let i = 0; i < 200; i++) console.log("ligne " + i)'
    await runner.run(plan([{ tool: 'node', args: ['-e', script] }]))

    // Le renderer cesse de poller des qu'il voit un statut final : un avis de
    // troncature ecrit apres (dans le finally) ne serait jamais affiche a
    // l'ecran. Il doit donc preceder la mise a jour du statut.
    expect(order).toEqual(['truncation', 'status:done'])
    expect(scanStatus(scanId)).toBe('done')
  }, 40_000)
})

describe('ScanRunner - arret de la descendance', () => {
  it('arrete les sous-processus de l outil, pas seulement l outil', async () => {
    const scanId = newScan()
    const counter = join(workDir, `counter-${scanId}.txt`)
    const childPath = join(workDir, 'child.js')
    const parentPath = join(workDir, 'parent.js')
    writeFileSync(childPath, `const fs = require('fs')\nsetInterval(() => fs.appendFileSync(${JSON.stringify(counter)}, 'x'), 40)\n`)
    writeFileSync(
      parentPath,
      `const { spawn } = require('child_process')\nspawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: 'ignore' })\nsetInterval(() => {}, 600000)\n`
    )

    const runner = new ScanRunner(scanId, { stepTimeoutMs: 30_000 })
    const running = runner.run(plan([{ tool: 'node', args: [parentPath] }]))
    // Le petit-fils a le temps de demarrer sous charge : on observe jusqu'a 5 s.
    let started = false
    for (let i = 0; i < 50 && !started; i++) {
      started = existsSync(counter) && statSync(counter).size > 0
      if (!started) await sleep(100)
    }
    expect(started).toBe(true)

    runner.stop()
    await running

    expect(scanStatus(scanId)).toBe('stopped')
    const sizeAfterStop = existsSync(counter) ? statSync(counter).size : 0
    await sleep(1500)
    const sizeLater = existsSync(counter) ? statSync(counter).size : 0
    // Le petit-fils ecrit encore ? Alors l outil a survecu a l'arret.
    expect(sizeLater).toBe(sizeAfterStop)
  }, 40_000)

  it('arrete aussi la descendance quand le plafond est atteint', async () => {
    const scanId = newScan()
    const counter = join(workDir, `counter-timeout-${scanId}.txt`)
    const childPath = join(workDir, 'child-timeout.js')
    const parentPath = join(workDir, 'parent-timeout.js')
    writeFileSync(childPath, `const fs = require('fs')\nsetInterval(() => fs.appendFileSync(${JSON.stringify(counter)}, 'x'), 40)\n`)
    writeFileSync(
      parentPath,
      `const { spawn } = require('child_process')\nspawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: 'ignore' })\nsetInterval(() => {}, 600000)\n`
    )

    const runner = new ScanRunner(scanId, { stepTimeoutMs: 1200 })
    await runner.run(plan([{ tool: 'node', args: [parentPath] }]))

    const sizeAfterTimeout = existsSync(counter) ? statSync(counter).size : 0
    await sleep(1500)
    expect(existsSync(counter) ? statSync(counter).size : 0).toBe(sizeAfterTimeout)
    expect(scanStatus(scanId)).toBe('error')
  }, 40_000)
})

describe('ScanRunner - etape wordlist', () => {
  it('compte un outil execute via la wordlist comme un outil ayant tourne', async () => {
    const wordlistDir = join(userData, 'tools', 'seclists', 'Discovery', 'Web-Content')
    mkdirSync(wordlistDir, { recursive: true })
    writeFileSync(join(wordlistDir, 'raft-medium-words.txt'), 'admin\nlogin\n')

    try {
      const scanId = newScan()
      const runner = new ScanRunner(scanId, { stepTimeoutMs: 30_000 })
      await runner.run(
        plan([
          { tool: 'node', args: ['MISSING_WORDLIST'] },
          { tool: 'binaire-inexistant-bd', args: [] }
        ])
      )

      // Sans le comptage de la branche wordlist, ranTools restait a 0 :
      // l'etape absente faisait basculer tout le scan en « error » alors
      // qu'un outil avait pourtant tourne.
      expect(scanStatus(scanId)).toBe('done')
      expect(events(scanId).some((m) => m.includes('absent(s)'))).toBe(true)
    } finally {
      rmSync(join(userData, 'tools', 'seclists'), { recursive: true, force: true })
    }
  }, 30_000)
})
