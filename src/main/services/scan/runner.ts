import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { getRepository } from '../../db'
import { resolveBinary, resolveWordlist } from '../tools/installer'
import { killTree } from '../proc'
import type { ScanPlan } from './plan'

export { killTree }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type ScanEventLevel = 'info' | 'ok' | 'warn' | 'err'

/** `done` : l'outil a tourné. `missing` : binaire absent. `timeout` : plafond atteint. */
type StepOutcome = 'done' | 'missing' | 'timeout'

const runners = new Map<number, ScanRunner>()

export function getRunner(scanId: number): ScanRunner | undefined {
  return runners.get(scanId)
}

export function activeScanCount(): number {
  let n = 0
  for (const r of runners.values()) if (!r.isStopped()) n += 1
  return n
}

export function activeScanForProgram(programId: string): ScanRunner | undefined {
  const repo = getRepository()
  for (const [scanId, r] of runners) {
    if (r.isStopped()) continue
    const scan = repo.getScan(scanId)
    if (scan && scan.program_id === programId) return r
  }
  return undefined
}

export function requestStop(scanId: number): boolean {
  const r = runners.get(scanId)
  if (!r) return false
  r.stop()
  return true
}

function binary(tool: string): string {
  return resolveBinary(tool) ?? tool
}

/**
 * Un outil de reconnaissance ne rend pas la main de lui-même : ffuf attend sur
 * stdin, nuclei peut boucler sur une cible, et un binaire planté ne se termine
 * jamais. Sans plafond, le scan reste « en cours » indéfiniment et l.stop() ne
 * libère rien. 30 min par etape : au-delà, l'outil est considéré bloqué.
 */
const STEP_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Plafond global d'un scan : 4 etapes x un grand nombre de cibles pouvait
 * durer des heures. Au-dela, le scan est arrete proprement.
 */
const TOTAL_TIMEOUT_MS = 60 * 60 * 1000

/** Plafond d'événements conservés par scan : un outil bavard ne sature pas la base. */
const MAX_EVENTS = 5000


export interface ScanRunnerOptions {
  /** Plafond d'une étape de scan, en ms. */
  stepTimeoutMs?: number
  /** Plafond d'événements conservés sur toute la durée du scan. */
  maxEvents?: number
  /** Plafond de durée de tout le scan, en ms (défaut 60 min). */
  totalTimeoutMs?: number
}

export class ScanRunner {
  private current: ChildProcessWithoutNullStreams | null = null
  private stopped = false
  private seq = 0
  private eventCount = 0
  private suppressed = 0
  /** Événements en attente d'écriture : on n'ouvre une transaction que par lot. */
  private pending: { seq: number; level: string; message: string; ts: number }[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly stepTimeoutMs: number
  private readonly maxEvents: number
  private readonly totalTimeoutMs: number
  private readonly deadline: number

  constructor(
    private readonly scanId: number,
    options: ScanRunnerOptions = {}
  ) {
    this.stepTimeoutMs = options.stepTimeoutMs ?? STEP_TIMEOUT_MS
    this.maxEvents = options.maxEvents ?? MAX_EVENTS
    this.totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS
    this.deadline = Date.now() + this.totalTimeoutMs
    runners.set(scanId, this)
  }

  private expired(): boolean {
    return Date.now() >= this.deadline
  }

  isStopped(): boolean {
    return this.stopped
  }

  stop(): void {
    this.stopped = true
    if (this.current && !this.current.killed) {
      try {
        killTree(this.current)
      } catch {
        /* ignore */
      }
    }
  }

  private log(level: ScanEventLevel, message: string): void {
    if (this.eventCount >= this.maxEvents) {
      this.suppressed += 1
      return
    }
    this.eventCount += 1
    this.seq += 1
    this.pending.push({ seq: this.seq, level, message, ts: Date.now() })
    if (this.pending.length >= 50 || this.closed) this.flushEvents()
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushEvents(), 200)
      this.flushTimer.unref()
    }
  }

  private flushEvents(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pending.length === 0) return
    const rows = this.pending
    this.pending = []
    getRepository().appendScanEvents(this.scanId, rows)
  }

  /** Un chunk réseau n'est pas une ligne : on ne journalise qu'aux retours à la ligne. */
  private emitLines(tail: string, chunk: Buffer): string {
    const parts = (tail + chunk.toString()).split(/\r?\n/)
    const rest = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (line) this.log('info', line.slice(0, 2000))
    }
    return rest
  }

  /**
   * Les lignes jetées au-delà du plafond sont annoncées une fois, à la fin :
   * sans cela, un scan tronqué passerait pour un scan propre.
   */
  private flushSuppressed(): void {
    if (this.suppressed === 0) return
    this.seq += 1
    this.suppressed = 0
    getRepository().appendScanEvent(
      this.scanId,
      this.seq,
      'warn',
      `Flux tronqué : lignes ignorées au-delà du plafond de ${this.maxEvents} événements.`,
      Date.now()
    )
  }

  /**
   * Clôt le scan. Invariant : TOUT événement (y compris l'avis de troncature,
   * écrit hors lot par flushSuppressed) doit être en base AVANT le statut final.
   * Le renderer cesse de poller dès qu'il voit un statut final (ScanProgressModal) :
   * un événement écrit après serait invisible à l'écran.
   */
  private finish(status: 'done' | 'error' | 'stopped'): void {
    this.closed = true
    this.flushEvents()
    this.flushSuppressed()
    getRepository().updateScan(this.scanId, { status, finishedAt: Date.now() })
  }

  async run(plan: ScanPlan): Promise<void> {
    try {
      this.log('info', `Scan démarré (${plan.depth}, ${plan.rateLimit} req/s) — ${plan.targets.length} cibles`)
      for (const t of plan.targets) this.log('info', `cible: ${t}`)

      const intervalMs = Math.max(50, Math.round(1000 / Math.max(1, plan.rateLimit)))

      const missingTools = new Set<string>()
      const timedOutTools = new Set<string>()
      let ranTools = 0
      for (const step of plan.steps) {
        if (this.stopped || this.expired()) break
        if (step.args.includes('MISSING_WORDLIST')) {
          const wl = resolveWordlist()
          if (wl) {
            const args = step.args.map((a) => (a === 'MISSING_WORDLIST' ? wl : a))
            this.log('info', `${step.tool} ${step.hint} (wordlist ${wl})`)
            if (this.stopped) break
            const wlOutcome = await this.runStep(step.tool, args)
            if (wlOutcome === 'missing') missingTools.add(step.tool)
            else if (wlOutcome === 'timeout') timedOutTools.add(step.tool)
            else ranTools += 1
            if (this.stopped) break
            await sleep(intervalMs)
            continue
          }
          this.log('warn', `${step.tool}: liste de mots non configurée, étape ignorée (${step.hint})`)
          continue
        }
        this.log('info', `${step.tool} ${step.hint}`)
        if (this.stopped) break
        const outcome = await this.runStep(step.tool, step.args)
        if (outcome === 'missing') {
          this.log('warn', `${step.tool}: binaire introuvable, étape ignorée`)
          missingTools.add(step.tool)
        } else if (outcome === 'timeout') {
          timedOutTools.add(step.tool)
        } else {
          ranTools += 1
        }
        if (this.stopped) break
        await sleep(intervalMs)
      }

      if (!this.stopped && this.expired()) {
        this.log('warn', `Plafond global de ${Math.round(this.totalTimeoutMs / 60000)} min atteint, scan arrêté avant la fin du plan`)
      }

      if (this.stopped) {
        this.log('warn', 'Scan interrompu par l’utilisateur')
        this.finish('stopped')
      } else if (ranTools === 0 && (missingTools.size > 0 || timedOutTools.size > 0)) {
        // Ne jamais annoncer « terminé » quand aucun binaire n'a pu être lancé :
        // l'utilisateur croirait avoir scanné alors que rien n'a tourné.
        if (missingTools.size > 0) {
          this.log(
            'err',
            `Aucun outil n’a pu être lancé (${[...missingTools].join(', ')}). Installez-les depuis l’écran Outils, puis relancez le scan.`
          )
        } else {
          this.log(
            'err',
            `Aucun outil n’a rendu de résultat avant le plafond de ${Math.round(this.stepTimeoutMs / 1000)} s (${[...timedOutTools].join(', ')}).`
          )
        }
        this.finish('error')
      } else if (missingTools.size > 0 || timedOutTools.size > 0) {
        const notes: string[] = []
        if (missingTools.size > 0) {
          notes.push(`${missingTools.size} outil(s) absent(s) : ${[...missingTools].join(', ')}`)
        }
        if (timedOutTools.size > 0) {
          notes.push(`${timedOutTools.size} étape(s) arrêtées au plafond de ${Math.round(this.stepTimeoutMs / 1000)} s : ${[...timedOutTools].join(', ')}`)
        }
        this.log('warn', `Scan terminé, mais ${notes.join(' ; ')}`)
        this.finish('done')
      } else {
        this.log('ok', 'Scan terminé')
        this.finish('done')
      }
    } catch (err) {
      this.log('err', `Erreur du moteur: ${err instanceof Error ? err.message : String(err)}`)
      this.finish('error')
    } finally {
      // Filet de sécurité : ferme les écritures même sur une sortie inattendue.
      this.closed = true
      this.flushEvents()
      this.flushSuppressed()
      runners.delete(this.scanId)
    }
  }

  private runStep(tool: string, args: string[]): Promise<StepOutcome> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams
      try {
        // detached: true place l'outil dans son propre groupe de processus,
        // ce qui rend l'arrêt de toute sa descendance possible (cf. killTree).
        child = spawn(binary(tool), args, { windowsHide: true, shell: false, detached: true })
      } catch {
        resolve('missing')
        return
      }
      this.current = child
      let existed = false
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        this.log('warn', `${tool}: délai de ${Math.round(this.stepTimeoutMs / 1000)} s dépassé, étape arrêtée`)
        killTree(child)
      }, this.stepTimeoutMs)
      timer.unref()
      let outTail = ''
      let errTail = ''
      const flushTails = (): void => {
        for (const tail of [errTail, outTail]) {
          const line = tail.trim()
          if (line) this.log('info', line.slice(0, 2000))
        }
        outTail = ''
        errTail = ''
      }
      let settled = false
      const settle = (outcome: StepOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        flushTails()
        if (this.current === child) this.current = null
        resolve(outcome)
      }
      child.on('spawn', () => {
        existed = true
      })
      child.stderr.on('data', (d: Buffer) => {
        errTail = this.emitLines(errTail, d)
      })
      child.stdout.on('data', (d: Buffer) => {
        outTail = this.emitLines(outTail, d)
      })
      child.on('error', () => {
        if (!timedOut) this.log('warn', `${tool}: lancement impossible`)
        settle(existed ? (timedOut ? 'timeout' : 'done') : 'missing')
      })
      child.on('exit', (code, signal) => {
        if (code !== null) this.log('info', `(${tool} exit ${code})`)
        else if (signal) this.log('warn', `(${tool} interrompu: ${signal})`)
        // Un exit obtenu après le plafond est un arrêt, pas un résultat.
        settle(timedOut ? 'timeout' : 'done')
      })
    })
  }
}

export async function startScan(scanId: number, plan: ScanPlan, options?: ScanRunnerOptions): Promise<void> {
  let runner = getRunner(scanId)
  if (!runner) runner = new ScanRunner(scanId, options)
  await runner.run(plan)
}