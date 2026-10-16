import { isIP } from 'node:net'
import type { ScanDepth, ScopeDomain } from '../../../shared/ipc'
import { resolveWebTarget } from '../../../shared/scan-targets'

export const SCAN_DEPTHS: ScanDepth[] = ['low', 'med', 'high']

export interface ScanStep {
  tool: string
  args: string[]
  hint: string
}

export interface ScanPlan {
  depth: ScanDepth
  rateLimit: number
  targets: string[]
  steps: ScanStep[]
  userAgent: string
  requestHeader?: string
}

export const MAX_TARGETS = 200

/** Traduit ::ffff:ABCD:EF00 en notation pointee, sinon null. */
function hexV4ToDotted(part: string): string | null {
  const groups = part.split(':')
  if (groups.length !== 2) return null
  const hi = Number.parseInt(groups[0]!, 16)
  const lo = Number.parseInt(groups[1]!, 16)
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

export function isPrivateHost(rawHost: string): boolean {
  // new URL() laisse les crochets autour des IPv6 et peut garder un point final.
  const h = rawHost.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true
  if (isIP(h) === 0) return false
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true
    const mapped = h.match(/^::ffff:(.+)$/)
    if (mapped) {
      const rest = mapped[1]!
      const dotted = rest.includes('.') ? rest : hexV4ToDotted(rest)
      return dotted ? isPrivateHost(dotted) : true // forme inconnue : on bloque
    }
    return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')
  }
  const parts = h.split('.').map((x) => Number(x))
  const a = parts[0] ?? 0
  const b = parts[1] ?? 0
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

const UA = 'Venari-scan/1.0'

export interface PlanOptions {
  userAgent?: string | null
  requestHeader?: string | null
}

export function selectTargets(scope: ScopeDomain[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of scope) {
    if (!d.inScope) continue
    const u = resolveWebTarget(d.endpoint)
    if (!u) continue
    if (isPrivateHost(u.hostname)) continue
    const norm = u.origin + u.pathname.replace(/\/+$/, '')
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

/** Hôtes in-scope d'un programme, normalisés (minuscules, sans crochets ni point final ni `*.`). */
export function inScopeHosts(scope: ScopeDomain[]): string[] {
  const hosts = new Set<string>()
  for (const d of scope) {
    if (!d.inScope) continue
    const u = resolveWebTarget(d.endpoint)
    if (!u) continue
    const host = u.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').replace(/^\*\./, '')
    if (host) hosts.add(host)
  }
  return [...hosts]
}

/** Vrai si l'hôte de l'URL correspond à une cible in-scope (ou un de ses sous-domaines). */
export function isUrlInScope(scope: ScopeDomain[], url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  if (!host) return false
  return inScopeHosts(scope).some((h) => host === h || host.endsWith(`.${h}`))
}

export function buildPlan(depth: ScanDepth, targets: string[], rateLimit: number, opts?: PlanOptions): ScanPlan {
  const steps: ScanStep[] = []
  const ua = opts?.userAgent?.trim() || UA
  const hdr = opts?.requestHeader?.trim() || undefined
  const headerArgs = hdr ? ['-H', hdr] : []
  for (const t of targets) {
    if (depth === 'low' || depth === 'med' || depth === 'high') {
      steps.push({
        tool: 'curl',
        args: ['-s', '-I', '--max-time', '15', '-A', ua, ...headerArgs, t],
        hint: `en-têtes HTTP ${t}`,
      })
    }
    const severity = depth === 'low' ? 'low,medium' : depth === 'med' ? 'low,medium,high' : 'low,medium,high,critical'
    steps.push({
      tool: 'nuclei',
      args: ['-u', t, '-severity', severity, '-silent', '-rate', String(rateLimit), '-stats-json'],
      hint: `nuclei (${severity}) ${t}`,
    })
    if (depth === 'med' || depth === 'high') {
      steps.push({
        tool: 'nuclei',
        args: ['-u', t, '-tags', 'tech,exposure', '-silent', '-rate', String(rateLimit)],
        hint: `nuclei tech/exposure ${t}`,
      })
    }
    if (depth === 'high') {
      steps.push({
        tool: 'ffuf',
        args: ['-u', `${t}/FUZZ`, '-w', 'MISSING_WORDLIST', '-mc', '200,204,301,302,307,401,403', '-rate', String(rateLimit)],
        hint: `ffuf découverte de chemins ${t}`,
      })
    }
  }
  return { depth, rateLimit, targets, steps, userAgent: ua, requestHeader: hdr }
}