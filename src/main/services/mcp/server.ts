import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import type { McpStatusInfo, ProgramDetailData, ScanDepth } from '../../../shared/ipc'
import { FINDING_SEVERITIES, FINDING_STATUSES } from '../../../shared/ipc'
import { Throttler } from '../../../services/intigriti'
import { getClient } from '../../app-state'
import { getRepository } from '../../db'
import { fetchProgramDetail, getCachedProgramDetail } from '../program-detail'
import { listReports, readReport } from '../reports'
import { buildPlan, inScopeHosts, isPrivateHost, isUrlInScope, selectTargets, MAX_TARGETS } from '../scan/plan'
import { activeScanCount, activeScanForProgram, killTree, startScan } from '../scan/runner'
import { getTool, TOOL_CATALOG } from '../tools/catalog'
import { currentTools, installTool, resolveBinary, toolsDir } from '../tools/installer'
import { attachAgentsToServer, closeAgents, configureAgents, type AgentAuthEntry } from './agents'
import { DISCOVERY_PORT, startDiscoveryResponder, stopDiscoveryResponder } from './discover'
import { openBrowserWindow } from '../../ipc-browser'
// Version réelle du paquet : une constante en dur dérive dès le premier bump.
import pkg from '../../../../package.json'

const PROTOCOL_VERSION = '2024-11-05'
const MAX_BODY = 1024 * 1024

const DEFAULT_RATE: Record<ScanDepth, number> = { low: 1, med: 5, high: 10 }

type ToolArgs = Record<string, unknown>
type ToolResult = { text: string; isError?: boolean; details?: Record<string, unknown> }

interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: ToolArgs) => Promise<ToolResult>
}

const STR = { type: 'string' } as const
const INT = { type: 'integer' } as const
const BOOL = { type: 'boolean' } as const

function asString(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (v.length === 0 || v.length > max) return null
  return v
}

function asInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value >= min && value <= max ? value : null
}

function severityByScore(score: number): (typeof FINDING_SEVERITIES)[number] {
  if (score >= 9) return 'critical'
  if (score >= 7) return 'high'
  if (score >= 4) return 'medium'
  if (score > 0) return 'low'
  return 'info'
}

/**
 * `submit_report` et `record_finding` acceptent « high », un score (7.5) ou un
 * vecteur CVSS complet. On normalise toujours vers le meme couple
 * (severite, score) pour que le suivi reste triable.
 */
function normalizeSeverity(raw: string | null): { severity: (typeof FINDING_SEVERITIES)[number]; cvss: number | null } {
  if (!raw) return { severity: 'info', cvss: null }
  const lowered = raw.trim().toLowerCase()
  if ((FINDING_SEVERITIES as readonly string[]).includes(lowered)) {
    return { severity: lowered as (typeof FINDING_SEVERITIES)[number], cvss: null }
  }
  const asNumber = Number(lowered)
  if (Number.isFinite(asNumber) && asNumber >= 0 && asNumber <= 10) {
    return { severity: severityByScore(asNumber), cvss: asNumber }
  }
  const computed = computeCvssBase(raw.trim())
  if (computed.ok) return { severity: severityByScore(computed.baseScore), cvss: computed.baseScore }
  return { severity: 'info', cvss: null }
}

/** Plafond du champ note d'un programme, toutes notes confondues. */
const NOTE_MAX_CHARS = 20_000
/** Format d'une ligne de note ajoutee par set_note. */
const NOTE_LINE = /^-\s*\[([^\]]{4,40})\]\s*(.+)$/

function splitArgs(str: string): string[] {
  // Supporte les guillemets simples (convention POSIX) comme les guillemets doubles.
  const tokens = str.match(/"[^"]*"|'[^']*'|\S+/g)
  if (!tokens) return []
  return tokens.map((t) =>
    (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
      ? t.slice(1, -1)
      : t
  )
}

// ---------------------------------------------------------------------------
// CVSS v3.1 — calcul pur, local, sans reseau.
//
// Poids et equations repris de la specification FIRST (section 7.1 et 7.4).
// L'arrondi "Roundup" est celui de l'annexe A : on travaille en milliemes pour
// que le resultat ne depende pas des arrondis flottants de la plateforme.
// Valeurs de reference croisees avec l'implementation officielle
// (first.org/cvss, CVSS31.calculateCVSSFromVector) : les 20 vecteurs
// verifies dans tests/mcp-http.test.ts (dont les exemples publies de FIRST)
// donnent le meme score. Les metriques temporelles et environnementales sont
// ignorees pour le score de base : elles sont signalees dans la reponse plutot
// que silencieuses.
// ---------------------------------------------------------------------------

const CVSS_WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  PR_U: { N: 0.85, L: 0.62, H: 0.27 },
  PR_C: { N: 0.85, L: 0.68, H: 0.5 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const

const CVSS_BASE_METRICS = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'] as const
/** Metriques hors base : acceptees pour ne pas rejeter un vecteur NVD, mais ignorees. */
const CVSS_OTHER_METRICS: Record<string, string[]> = {
  E: ['X', 'U', 'P', 'F', 'H'],
  RL: ['X', 'O', 'T', 'W', 'U'],
  RC: ['X', 'C', 'R', 'U'],
  CR: ['X', 'L', 'M', 'H'],
  IR: ['X', 'L', 'M', 'H'],
  AR: ['X', 'L', 'M', 'H'],
  MAV: ['X', 'N', 'A', 'L', 'P'],
  MAC: ['X', 'L', 'H'],
  MPR: ['X', 'N', 'L', 'H'],
  MUI: ['X', 'N', 'R'],
  MS: ['X', 'U', 'C'],
  MC: ['X', 'N', 'L', 'H'],
  MI: ['X', 'N', 'L', 'H'],
  MA: ['X', 'N', 'L', 'H'],
}

/** Roundup a une decimale (annexe A de la specification). */
function cvssRoundup(value: number): number {
  const intInput = Math.round(value * 100_000)
  if (intInput % 10_000 === 0) return intInput / 100_000
  return (Math.floor(intInput / 10_000) + 1) / 10
}

function cvssSeverity(score: number): string {
  if (score === 0) return 'Aucun'
  if (score < 4) return 'Faible'
  if (score < 7) return 'Moyen'
  if (score < 9) return 'Élevé'
  return 'Critique'
}

function cvssRound(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

type CvssComputation =
  | {
      ok: true
      input: string
      baseVector: string
      version: string
      baseScore: number
      severity: string
      iss: number
      impact: number
      exploitability: number
      metrics: Record<string, string>
      ignoredMetrics: string[]
    }
  | { ok: false; error: string }

/**
 * Calcule le score de base CVSS v3.1 d'un vecteur. Le prefixe "CVSS:3.1" est
 * recommande mais facultatif ; "CVSS:3.0" est accepte car les poids des
 * metriques de base sont identiques (seules les formules environnementales
 * different, et elles ne sont pas calculees ici).
 */
function computeCvssBase(raw: string): CvssComputation {
  let version = '3.1'
  let body = raw.trim()
  const prefix = /^CVSS:(\d\.\d)\//i.exec(body)
  if (prefix) {
    version = prefix[1]!
    if (version !== '3.1' && version !== '3.0') {
      return { ok: false, error: `Version CVSS non gérée : ${version} (outil limité à 3.1)` }
    }
    body = body.slice(prefix[0].length)
  } else if (/^CVSS:/i.test(body)) {
    return { ok: false, error: 'Préfixe de version mal formé (attendu CVSS:3.1/...)' }
  }

  const metrics: Record<string, string> = {}
  const ignored: string[] = []
  for (const part of body.split('/')) {
    if (part === '') continue
    const kv = /^([A-Za-z]{1,3}):([A-Za-z])$/.exec(part)
    if (!kv) return { ok: false, error: `Segment de vecteur illisible : ${part}` }
    const key = kv[1]!.toUpperCase()
    const val = kv[2]!.toUpperCase()
    if (key in metrics) return { ok: false, error: `Métrique en double : ${key}` }
    const others = CVSS_OTHER_METRICS[key]
    if (others) {
      if (!others.includes(val)) return { ok: false, error: `Valeur invalide pour ${key} : ${val}` }
      metrics[key] = val
      ignored.push(key)
      continue
    }
    const baseIndex = CVSS_BASE_METRICS.indexOf(key as (typeof CVSS_BASE_METRICS)[number])
    if (baseIndex === -1) return { ok: false, error: `Métrique inconnue : ${key}` }
    metrics[key] = val
  }

  for (const key of CVSS_BASE_METRICS) {
    if (!(key in metrics)) return { ok: false, error: `Métrique de base manquante : ${key}` }
  }
  if (metrics.S !== 'U' && metrics.S !== 'C') {
    return { ok: false, error: `Valeur invalide pour S : ${metrics.S}` }
  }

  const av = CVSS_WEIGHTS.AV[metrics.AV as keyof typeof CVSS_WEIGHTS.AV]
  const ac = CVSS_WEIGHTS.AC[metrics.AC as keyof typeof CVSS_WEIGHTS.AC]
  const prTable = metrics.S === 'C' ? CVSS_WEIGHTS.PR_C : CVSS_WEIGHTS.PR_U
  const pr = prTable[metrics.PR as keyof typeof prTable]
  const ui = CVSS_WEIGHTS.UI[metrics.UI as keyof typeof CVSS_WEIGHTS.UI]
  const cia = CVSS_WEIGHTS.CIA
  const c = cia[metrics.C as keyof typeof cia]
  const i = cia[metrics.I as keyof typeof cia]
  const a = cia[metrics.A as keyof typeof cia]
  const scopeChanged = metrics.S === 'C'
  if ([av, ac, pr, ui, c, i, a].some((v) => v === undefined)) {
    return { ok: false, error: 'Valeur de métrique de base hors domaine' }
  }

  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!)
  const impact = scopeChanged
    ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
    : 6.42 * iss
  const exploitability = 8.22 * av! * ac! * pr! * ui!
  const raw0 = impact <= 0
    ? 0
    : scopeChanged
      ? cvssRoundup(Math.min(1.08 * (impact + exploitability), 10))
      : cvssRoundup(Math.min(impact + exploitability, 10))

  const ordered = CVSS_BASE_METRICS.map((k) => `${k}:${metrics[k]}`).join('/')
  return {
    ok: true,
    input: raw,
    baseVector: `CVSS:${version}/${ordered}`,
    version,
    baseScore: raw0,
    severity: cvssSeverity(raw0),
    iss: cvssRound(iss),
    impact: cvssRound(impact),
    exploitability: cvssRound(exploitability),
    metrics: Object.fromEntries(CVSS_BASE_METRICS.map((k) => [k, metrics[k]!])),
    ignoredMetrics: ignored,
  }
}

// ---------------------------------------------------------------------------
// Lecture de page distante (GET uniquement, sans identifiant).
//
// Cette lecture sert a consulter une politique de programme, un scope ou un
// advisory. Elle n'envoie aucun cookie, aucun header Authorization et ne
// reutilise pas le jeton Intigriti : un GET anonyme ne peut donc passubmittre
// quoi que ce soit. Les bornees (protocole, taille, delai, redirections) sont
// la seule protection contre un agent qui pointe l'outil n'importe ou.
// ---------------------------------------------------------------------------

const PAGE_TIMEOUT_MS = 15_000
const PAGE_MAX_REDIRECTS = 5
const PAGE_USER_AGENT = `Venari/${pkg.version} (lecteur de page pour agent IA, GET seul)`

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'",
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç', ugrave: 'ù',
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{0,10});/g, (match, name: string) => {
    const key = name.toLowerCase()
    const direct = HTML_ENTITIES[key]
    if (direct !== undefined) return direct
    if (key.startsWith('#x') || key.startsWith('#')) {
      const cp = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10)
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) return String.fromCodePoint(cp)
    }
    return match
  })
}

/** HTML -> texte : supprime script/style/contenus non rendus, garde les sauts de blocs. */
function htmlToText(html: string): string {
  let out = html
  out = out.replace(/<!--[\s\S]*?-->/g, ' ')
  out = out.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
  out = out.replace(/<\/?(script|style|noscript|template|svg)\b[^>]*>/gi, ' ')
  out = out.replace(
    /<\/?(p|div|br|li|ul|ol|tr|td|th|table|thead|tbody|section|article|header|footer|nav|aside|main|h[1-6]|pre|blockquote|form|hr|dl|dt|dd)\b[^>]*>/gi,
    '\n',
  )
  out = out.replace(/<[^>]*>/g, ' ')
  out = decodeEntities(out)
  return out
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

function isHttpUrl(u: URL): boolean {
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== ''
}

/**
 * Filtre SSRF commun a fetch_page et http_request : refuse un hote prive ou
 * local (loopback, RFC1918, link-local, metadonnees cloud) ou dont une adresse
 * resolue est privee (anti DNS-rebinding partiel). Retourne le motif du refus,
 * ou null si la cible est autorisee.
 *
 * `VENARI_ALLOW_PRIVATE_FETCH=1` n'est jamais positionne par l'application : il
 * sert uniquement aux tests HTTP qui visent un serveur boucle locale.
 */
async function ssrfRefusal(u: URL): Promise<string | null> {
  if (process.env['VENARI_ALLOW_PRIVATE_FETCH'] === '1') return null
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return 'Hote absent'
  if (isPrivateHost(host)) return `Cible privee ou locale refusee : ${host}`
  if (isIP(host) !== 0) return null
  let addrs: { address: string }[]
  try {
    addrs = await dnsLookup(host, { all: true })
  } catch {
    return `Hote introuvable : ${host}`
  }
  for (const a of addrs) {
    if (isPrivateHost(a.address)) return `Hote ${host} resout vers une adresse privee (${a.address})`
  }
  return null
}

/** Limiteur de debit des requetes http_request : borne les appels sortants. */
const httpRequestThrottle = new Throttler({ capacity: 30, refillPerInterval: 10, refillIntervalMs: 1000 })

/** Lit le corps en plafonnant les octets : au-dela, on coupe et on le signale. */
async function readCapped(res: Response, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  const body = res.body
  if (!body) return { buf: Buffer.alloc(0), truncated: false }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > maxBytes) {
      chunks.push(Buffer.from(value.subarray(0, value.byteLength - (size - maxBytes))))
      truncated = true
      break
    }
    chunks.push(Buffer.from(value))
  }
  try {
    await reader.cancel()
  } catch {
    // le corps est de toute facon abandonne
  }
  return { buf: Buffer.concat(chunks), truncated }
}

type PageResult =
  | {
      ok: true
      url: string
      finalUrl: string
      status: number
      contentType: string
      bytes: number
      truncated: boolean
      raw: string
    }
  | { ok: false; error: string }

async function fetchPageText(startUrl: string, maxBytes: number): Promise<PageResult> {
  let current = startUrl
  for (let hop = 0; hop <= PAGE_MAX_REDIRECTS; hop++) {
    let cur: URL
    try {
      cur = new URL(current)
    } catch {
      return { ok: false, error: `URL illisible : ${current}` }
    }
    // Le filtre est réappliqué à chaque saut : une redirection ne doit pas
    // ramener vers une cible privée (loopback, RFC1918, métadonnées cloud).
    const refusal = await ssrfRefusal(cur)
    if (refusal) return { ok: false, error: refusal }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        credentials: 'omit',
        headers: {
          'user-agent': PAGE_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
          'accept-language': 'en',
        },
      })
    } catch (err) {
      clearTimeout(timer)
      const reason = err instanceof Error ? err.name === 'AbortError' ? `délai de ${PAGE_TIMEOUT_MS / 1000} s dépassé` : err.message : String(err)
      return { ok: false, error: `GET ${current} impossible : ${reason}` }
    }

    const location = res.headers.get('location')
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      void res.body?.cancel()
      clearTimeout(timer)
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return { ok: false, error: `Redirection vers une URL illisible : ${location}` }
      }
      if (!isHttpUrl(next)) {
        return { ok: false, error: `Redirection vers un protocole non autorisé (${next.protocol})` }
      }
      current = next.toString()
      continue
    }

    try {
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} sur ${current}` }
      }
      const contentType = res.headers.get('content-type') ?? ''
      const { buf, truncated } = await readCapped(res, maxBytes)
      const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]
      let raw: string
      try {
        raw = new TextDecoder(charset && /^[A-Za-z0-9_-]+$/.test(charset) ? charset : 'utf-8').decode(buf)
      } catch {
        raw = buf.toString('utf-8')
      }
      return { ok: true, url: startUrl, finalUrl: current, status: res.status, contentType, bytes: buf.byteLength, truncated, raw }
    } catch (err) {
      const reason = err instanceof Error ? (err.name === 'AbortError' ? `délai de ${PAGE_TIMEOUT_MS / 1000} s dépassé` : err.message) : String(err)
      return { ok: false, error: `Lecture de ${current} interrompue : ${reason}` }
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: `Trop de redirections (plafond ${PAGE_MAX_REDIRECTS})` }
}

/**
 * Canonicalise une URL pour dedoublonner : casse de l'hote, port par defaut,
 * fragment et parametres de suivi retires, query triee, slash final de chemin
 * normalise (sauf racine). Le path sert de cle de regroupement par endpoint.
 */
function canonicalizeUrl(raw: string): { url: string; endpoint: string } | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (!isHttpUrl(u)) return null
  u.hash = ''
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = ''
  const kept: Array<[string, string]> = []
  for (const [key, value] of u.searchParams) {
    const lower = key.toLowerCase()
    if (lower.startsWith('utm_') || lower === 'gclid' || lower === 'fbclid' || lower === 'msclkid' || lower === '_ga') continue
    kept.push([key, value])
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  u.search = ''
  for (const [key, value] of kept) u.searchParams.append(key, value)
  if (u.pathname.length > 1) {
    const trimmed = u.pathname.replace(/\/+$/, '')
    u.pathname = trimmed === '' ? '/' : trimmed
  }
  return { url: u.toString(), endpoint: `${u.host}${u.pathname}` }
}

/** Extrait les URL http(s) d'une ligne de log ou de sortie d'outil. */
function extractUrls(line: string): string[] {
  const matches = line.match(/https?:\/\/[^\s<>"'`[\]{}\\^|]+/g)
  if (!matches) return []
  return matches
    .map((raw) => raw.replace(/[.,;:!?'")\]}>]+$/, ''))
    .filter((raw) => raw.length > 'https://'.length)
}

const DENY_TOOLS = new Set([
  // Telechargeurs et lanceurs indirects : contournent le controle d'integrite
  // des outils du catalogue ou executent du code hors du couple argv/suivi.
  'mshta', 'rundll32', 'regsvr32', 'certutil', 'bitsadmin',
  'wscript', 'cscript', 'winget', 'eval', 'xargs',
  // PowerShell reste refuse : equivalent de shell systeme sur Windows, et
  // dispose de.cmdlets d'execution memoire que le suivi d'argv ne couvre pas.
  'cmd', 'powershell', 'pwsh',
  // Runtimes et chaines du catalogue : le catalogue expose des binaires qui
  // sont eux-memes de l'execution arbitraire (node -e, python -c, go run,
  // git -c alias.x=!cmd, uv pip…). Les laisser passer via getTool aurait
  // redonne aux porteurs de jeton exactement le RCE refuse par SAFE_TOOLS.
  'node', 'nodejs', 'python', 'python3', 'py', 'go', 'golang', 'uv',
  'deno', 'bun', 'php', 'ruby', 'perl', 'lua', 'java', 'jdk', 'pip', 'npm', 'npx',
  'awk', 'sed', 'find', 'make', 'cmake', 'gcc', 'g++', 'curl', 'wget',
  'nc', 'ncat', 'socat',
])
const SAFE_TOOLS = new Set([
  // Utilitaires sans point d'execution en ligne de commande : aucun d'eux ne
  // lance un sous-processus arbitraire a partir de ses arguments (pas de
  // `sh -c`, `python -c`, `awk system()`, `sed e`, `find -exec`, `fd --exec`,
  // `tar --to-command`, `git -c alias.x=!cmd`, `curl`/`wget` de telechargement).
  // Toute coquille, interpreteur, chaine d'outils ou telechargeur est exclu :
  // ils annulaient DENY_TOOLS et donnerent un RCE a tout porteur de jeton.
  // Lecture / comparaison de texte
  'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'tee', 'grep',
  'diff', 'patch', 'strings', 'base64', 'xxd', 'rg',
  // Fichiers et repertoires (aucune execution)
  'ls', 'mkdir', 'cp', 'mv', 'rm', 'touch', 'chmod', 'stat', 'file', 'du', 'df',
  // Donnees structurees
  'jq', 'yq',
  // Diagnostic reseau (sondes, jamais de relais ni de telechargement)
  'ping', 'dig', 'nslookup', 'host', 'whois', 'traceroute', 'tracert',
  'netstat', 'ss', 'ip', 'ifconfig',
])

function isAllowedRunTool(tool: string): boolean {
  const name = tool.toLowerCase().replace(/\.exe$/i, '')
  if (DENY_TOOLS.has(name)) return false
  if (SAFE_TOOLS.has(name)) return true
  return getTool(tool) !== undefined
}

const runToolDef: McpToolDef = {
  name: 'run_tool',
  description:
    'Exécute un binaire du catalogue Venari (portable dans le dossier tools de Venari, ou binaire PATH comme'
    + ' nmap/ffuf) ou un utilitaire système sans exécution arbitraire (lecture/texte/réseau : cat, grep, jq, rg,'
    + ' dig, ping, base64…). Les coquilles, interpréteurs et téléchargeurs (sh, bash, node, python, curl, wget…)'
    + ' sont refusés. Les arguments forment une chaîne unique, cwd optionnel (sous-dossier existant du dossier tools'
    + ' de Venari, jamais sa racine), timeout par défaut 120 s. Toute invocation est journalisée (Activité des IA).'
    + ' À n’utiliser que sur des cibles autorisées, dans le scope et selon les ROE.',
  inputSchema: {
    type: 'object',
    properties: {
      tool: { ...STR, description: 'id du catalogue (voir list_tools) ou binaire système de confiance' },
      args: { type: 'string', description: 'arguments de ligne de commande, une seule chaîne (guillemets double pour grouper)' },
      cwd: { type: 'string', description: 'répertoire de travail absolu sous le dossier tools (optionnel)' },
      timeout: { type: 'integer', minimum: 1, maximum: 600, description: 'secondes, défaut 120' },
    },
    required: ['tool'],
  },
  handler: async (args) => {
    const tool = asString(args.tool, 60)
    if (!tool) return { text: 'tool requis (chaîne 1-60)', isError: true }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(tool)) return { text: `Nom de binaire invalide : ${tool}`, isError: true }
    if (!isAllowedRunTool(tool)) {
      return { text: `Outil bloqué : ${tool} (hors catalogue et hors liste système de confiance)`, isError: true }
    }
    const argStr = typeof args.args === 'string' ? args.args.slice(0, 8000) : ''
    const timeout = asInt(args.timeout, 1, 600) ?? 120
    const toolsRoot = toolsDir()
    const rawCwd = asString(args.cwd, 400)
    let cwd = toolsRoot
    if (rawCwd) {
      const abs = resolve(rawCwd)
      const lower = abs.toLowerCase()
      if (lower.startsWith('\\\\') || lower.startsWith('//')) {
        return { text: 'Chemin réseau (UNC) refusé', isError: true }
      }
      try {
        if (!statSync(abs).isDirectory()) return { text: 'cwd invalide : pas un répertoire', isError: true }
      } catch {
        return { text: 'cwd invalide : n’existe pas', isError: true }
      }
      // Chemins réels : une jonction ou un lien symbolique sous tools ne doit pas
      // faire passer un dossier situé ailleurs (C:\Windows, etc.).
      let realRoot: string
      let realAbs: string
      try {
        realRoot = realpathSync(toolsRoot)
        realAbs = realpathSync(abs)
      } catch {
        return { text: 'cwd invalide : chemin non résolvable', isError: true }
      }
      const root = realRoot.toLowerCase().replace(/[\\/]+$/, '')
      const realLower = realAbs.toLowerCase()
      const insideRoot = realLower === root || realLower.startsWith(root + '\\') || realLower.startsWith(root + '/')
      if (!insideRoot) {
        return { text: 'cwd hors périmètre autorisé (dossier tools Venari)', isError: true }
      }
      // La racine elle-même est réservée : c'est le dossier inscriptible que
      // visait le détournement de binaire (un faux git.exe y serait résolu).
      if (realLower === root) {
        return { text: 'cwd refusé : la racine du dossier tools est réservée à Venari', isError: true }
      }
      cwd = abs
    }
    const bin = resolveBinary(tool) ?? tool
    const argv = splitArgs(argStr)

    return await new Promise<ToolResult>((resolveRes) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(bin, argv, { windowsHide: true, shell: false, cwd })
      } catch (err) {
        resolveRes({ text: `Impossible de lancer ${tool} : ${err instanceof Error ? err.message : String(err)}`, isError: true })
        return
      }
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        // child.kill() ne touche que le pid direct : curl, git et les outils du
        // catalogue lancent des sous-processus qui resteraient orphelins.
        killTree(child)
      }, timeout * 1000)
      child.stdout?.on('data', (b: Buffer) => {
        stdout += b.toString()
        if (stdout.length > 200_000) stdout = stdout.slice(0, 200_000)
      })
      child.stderr?.on('data', (b: Buffer) => {
        stderr += b.toString()
        if (stderr.length > 100_000) stderr = stderr.slice(0, 100_000)
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        resolveRes({ text: `Lancement de ${tool} échoué : ${err.message}`, isError: true })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolveRes({
          text: JSON.stringify(
            { tool, bin, exitCode: code, timedOut, stdout: stdout.slice(0, 100_000), stderr: stderr.slice(0, 50_000) },
            null, 2
          ),
          details: { tool, exitCode: code, timedOut },
        })
      })
    })
  },
}

/** Détail d'un programme : fraîcheur via l'API si un jeton est présent, sinon cache local. */
async function resolveProgramDetail(programId: string): Promise<ProgramDetailData | null> {
  if (getClient().getToken()) {
    try {
      return await fetchProgramDetail(getClient(), programId)
    } catch {
      return getCachedProgramDetail(programId)
    }
  }
  return getCachedProgramDetail(programId)
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

const TOOL_DEFS: McpToolDef[] = [
  {
    name: 'list_programs',
    description: "Liste les programmes bug bounty du catalogue local (Venari). Recherche par nom/handle et filtre favoris."
      + ' Retourne les enregistrements de programmes (prime min/max, statut, tags, groupes, favori).'
      + ' Paginé : au-delà de 200 programmes, préciser offset pour lire la suite (total et hasMore sont dans details).',
    inputSchema: {
      type: 'object',
      properties: {
        search: { ...STR, description: 'filtre texte sur nom, handle ou industrie' },
        favoriteOnly: BOOL,
        limit: { ...INT, minimum: 1, maximum: 200, description: 'taille de page (défaut 200)' },
        offset: { ...INT, minimum: 0, description: 'décalage dans le résultat (défaut 0)' },
      },
    },
    handler: async (args) => {
      const repo = getRepository()
      const search = typeof args.search === 'string' ? args.search.slice(0, 500) : undefined
      const favoriteOnly = args.favoriteOnly === true
      const limit = args.limit === undefined ? 200 : asInt(args.limit, 1, 200)
      if (limit === null) return { text: 'limit doit être un entier entre 1 et 200', isError: true }
      const offset = args.offset === undefined ? 0 : asInt(args.offset, 0, 1_000_000)
      if (offset === null) return { text: 'offset doit être un entier positif', isError: true }
      const { records, total } = repo.listPrograms({ search, favoriteOnly, limit, offset })
      const out = records.map((r) => ({
        id: r.id, handle: r.handle, name: r.name, status: r.status, type: r.type,
        confidentiality: r.confidentiality, industry: r.industry, webLink: r.webLink,
        following: r.following, favorite: r.favorite, note: r.note || null,
        minBounty: r.minBounty, maxBounty: r.maxBounty, tags: r.tags, groups: r.groups,
      }))
      return {
        text: JSON.stringify(out, null, 2),
        details: { count: out.length, total, offset, hasMore: offset + out.length < total },
      }
    },
  },
  {
    name: 'get_program_detail',
    description: "Récupère le détail d'un programme : scope (cibles in-scope/out-of-scope), règles d'engagement (ROE),"
      + ' primes, statut. Nécessite un programme préalablement listé.',
    inputSchema: {
      type: 'object',
      properties: { programId: { ...STR, description: 'identifiant du programme (champ id de list_programs)' } },
      required: ['programId'],
    },
    handler: async (args) => {
      const programId = asString(args.programId)
      if (!programId) return { text: 'programId requis (chaîne 1-200)', isError: true }
      const detail = await resolveProgramDetail(programId)
      if (!detail) return { text: `Programme introuvable ou détail indisponible : ${programId}`, isError: true }
      return { text: JSON.stringify(detail, null, 2) }
    },
  },
  {
    name: 'list_credentials',
    description: 'Liste les identifiants stockés localement pour un programme (labels et usernames uniquement — jamais les secrets).',
    inputSchema: {
      type: 'object',
      properties: { programId: STR },
      required: ['programId'],
    },
    handler: async (args) => {
      const programId = asString(args.programId)
      if (!programId) return { text: 'programId requis', isError: true }
      const rows = getRepository().listCredentials(programId)
      const out = rows.map((r) => ({ id: r.id, label: r.label, username: r.username, note: r.note, updatedAt: r.updated_at }))
      return { text: JSON.stringify(out, null, 2), details: { count: out.length } }
    },
  },
  {
    name: 'set_note',
    description: 'Ajoute une note horodatée à un programme (ajout seul : le contenu existant n’est jamais écrasé).'
      + ' Stockage : le champ texte de note du programme, ce n’est pas une table de notes dédiée — une vraie table'
      + ' (historique, recherche) serait plus adaptée mais n’existe pas encore. Plafond : 4 000 caractères par note,'
      + ' 20 000 au total par programme. N’écrit rien d’autre que cette note.',
    inputSchema: {
      type: 'object',
      properties: {
        programId: { ...STR, description: 'identifiant du programme (champ id de list_programs)' },
        text: { ...STR, description: 'texte de la note, 1-4000 caractères' },
      },
      required: ['programId', 'text'],
    },
    handler: async (args) => {
      const repo = getRepository()
      const programId = asString(args.programId)
      if (!programId) return { text: 'programId requis (chaîne 1-200)', isError: true }
      const text = asString(args.text, 4000)
      if (!text) return { text: 'text requis (chaîne 1-4000)', isError: true }
      const program = repo.getProgram(programId)
      if (!program) return { text: `Programme introuvable : ${programId}`, isError: true }
      const entry = `- [${new Date().toISOString()}] ${text.replace(/\r?\n/g, ' ')}`
      const existing = program.note ?? ''
      const merged = existing === '' ? entry : `${existing.replace(/\s+$/, '')}\n${entry}`
      if (merged.length > NOTE_MAX_CHARS) {
        return {
          text: `Note refusée : le total dépasserait ${NOTE_MAX_CHARS} caractères (actuel ${existing.length}).`
            + ' Aucun caractère n’a été supprimé : archivez ou effacez la note depuis l’interface avant de continuer.',
          isError: true,
        }
      }
      repo.setNote(programId, merged)
      const entries = merged.split('\n').filter((line) => NOTE_LINE.test(line)).length
      return { text: JSON.stringify({ programId, entries, chars: merged.length }, null, 2), details: { programId, entries } }
    },
  },
  {
    name: 'list_notes',
    description: 'Relit les notes d’un programme (champ note du programme) sous forme d’entrées horodatées,'
      + ' de la plus ancienne à la plus récente. Lecture seule.',
    inputSchema: {
      type: 'object',
      properties: {
        programId: { ...STR, description: 'identifiant du programme' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'nombre d’entrées à renvoyer (défaut 50)' },
      },
      required: ['programId'],
    },
    handler: async (args) => {
      const repo = getRepository()
      const programId = asString(args.programId)
      if (!programId) return { text: 'programId requis (chaîne 1-200)', isError: true }
      const limit = args.limit === undefined ? 50 : asInt(args.limit, 1, 200)
      if (limit === null) return { text: 'limit doit être un entier entre 1 et 200', isError: true }
      const program = repo.getProgram(programId)
      if (!program) return { text: `Programme introuvable : ${programId}`, isError: true }
      const all = (program.note ?? '')
        .split('\n')
        .map((line) => NOTE_LINE.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ ts: m[1]!, text: m[2]!.trim() }))
      const entries = all.slice(Math.max(0, all.length - limit))
      return {
        text: JSON.stringify(
          {
            programId,
            handle: program.handle,
            name: program.name,
            storage: 'champ note du programme (table de notes dédiée non disponible)',
            total: all.length,
            returned: entries.length,
            entries,
          },
          null,
          2,
        ),
        details: { programId, total: all.length },
      }
    },
  },
  {
    name: 'list_tools',
    description: "État d'installation des outils bug bounty du catalogue Venari (nmap, nuclei, ffuf, gobuster, etc.)."
      + ' Retourne pour chaque outil si le binaire est installé.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const tools = await currentTools()
      return { text: JSON.stringify(tools, null, 2), details: { count: tools.length } }
    },
  },
  {
    name: 'install_tool',
    description: "Lance l'installation d'un outil du catalogue (winget ou binaire portable GitHub). Long : attendre la fin"
      + " avant de relancer. Voir list_tools pour les identifiants valides.",
    inputSchema: {
      type: 'object',
      properties: { id: { ...STR, enum: TOOL_CATALOG.map((t) => t.id) } },
      required: ['id'],
    },
    handler: async (args) => {
      const id = asString(args.id, 100)
      if (!id || !getTool(id)) return { text: `Outil inconnu : ${String(args.id)}`, isError: true }
      const chunks: string[] = []
      const res = await installTool(id, (line) => chunks.push(line))
      const output = chunks.join('')
      if (!res.ok) return { text: `${res.error}\n${output}`, isError: true }
      return { text: `${id} installé : ${res.installed ? 'oui' : 'non (déjà présent)'}\n${output}` }
    },
  },
  runToolDef,
  {
    name: 'open_browser',
    description: "Ouvre le navigateur intégré de l'onglet Assistant (une seule fenêtre au lieu d'empiler des onglets)"
      + ' et y affiche une URL. Ouvre une page d\'accueil si url est omis. Seuls http et https sont acceptés.'
      + " Le site est rendu dans une iframe sandboxée : il ne peut soumettre aucun rapport ni appeler l'API de Venari."
      + ' Utilise-le pour lire une doc, un scope ou un advisory. Ne l\'utilise jamais pour soumettre quoi que ce soit.',
    inputSchema: {
      type: 'object',
      properties: { url: { ...STR, description: 'URL absolue http(s) à afficher (optionnelle)' } },
    },
    handler: async (args) => {
      const url = asString(args.url, 2000) ?? undefined
      const res = openBrowserWindow(url)
      if (!res.ok) return { text: res.error ?? 'Ouverture du navigateur impossible', isError: true }
      return {
        text: `Navigateur intégré ouvert${url ? ` sur ${url}` : ''}. Aucun accès privilégié pour la page distante : aucun rapport ne peut y être soumis.`,
        details: { opened: true, url: url ?? null },
      }
    },
  },
  {
    name: 'fetch_page',
    description: 'GET sur une URL http(s) et retour du texte lisible (balises, scripts, styles et commentaires retirés),'
      + ' pour lire une politique de programme, un scope ou un advisory sans passer par le navigateur.'
      + ' GET uniquement : aucune soumission, aucun envoi de formulaire, aucun rapport possible.'
      + ' Aucun cookie, aucun header Authorization, aucun identifiant stocké n’est transmis : la requête est anonyme.'
      + ' Bornes : http(s) uniquement (file://, ftp:// et autres refusés), 1 MiB de réponse par défaut (max 2 MiB),'
      + ' 40 000 caractères rendus (max 200 000), 15 s de délai, 5 redirections maximum.'
      + ' À n’utiliser que sur des pages publiques ou explicitement autorisées par les ROE du programme.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { ...STR, description: 'URL absolue http(s) à lire' },
        maxBytes: { type: 'integer', minimum: 1024, maximum: 2_097_152, description: 'octets maximum lus, défaut 1 MiB' },
        maxChars: { type: 'integer', minimum: 500, maximum: 200_000, description: 'caractères maximum rendus, défaut 40000' },
      },
      required: ['url'],
    },
    handler: async (args) => {
      const raw = asString(args.url, 2000)
      if (!raw) return { text: 'url requis (chaîne 1-2000)', isError: true }
      let parsed: URL
      try {
        parsed = new URL(raw)
      } catch {
        return { text: `URL invalide : ${raw}`, isError: true }
      }
      if (!isHttpUrl(parsed)) {
        return { text: `Protocole refusé (${parsed.protocol}) : seuls http et https sont acceptés`, isError: true }
      }
      const maxBytes = args.maxBytes === undefined ? 1_048_576 : asInt(args.maxBytes, 1024, 2_097_152)
      if (maxBytes === null) return { text: 'maxBytes doit être un entier entre 1024 et 2097152', isError: true }
      const maxChars = args.maxChars === undefined ? 40_000 : asInt(args.maxChars, 500, 200_000)
      if (maxChars === null) return { text: 'maxChars doit être un entier entre 500 et 200000', isError: true }
      const res = await fetchPageText(parsed.toString(), maxBytes)
      if (!res.ok) return { text: res.error, isError: true }
      const contentType = res.contentType
      const textual = contentType === '' || /^text\/|json|xml|javascript|\+xml/i.test(contentType)
      if (!textual) {
        return { text: `Type de contenu non textuel (${contentType}) : fetch_page ne rend que du texte`, isError: true }
      }
      const isHtml = /html/i.test(contentType) || /^\s*(<!doctype\s+html|<html)\b/i.test(res.raw)
      const text = isHtml ? htmlToText(res.raw) : decodeEntities(res.raw)
      const clipped = text.length > maxChars ? text.slice(0, maxChars) : text
      return {
        text: JSON.stringify(
          {
            url: res.url,
            finalUrl: res.finalUrl,
            status: res.status,
            contentType: contentType || null,
            format: isHtml ? 'html' : 'texte',
            bytesRead: res.bytes,
            truncated: res.truncated || clipped.length < text.length,
            chars: clipped.length,
            text: clipped,
          },
          null,
          2,
        ),
        details: { url: res.url, finalUrl: res.finalUrl, status: res.status, chars: clipped.length },
      }
    },
  },
  {
    name: 'list_scans',
    description: 'Historique des scans lancés par start_scan pour un programme : identifiant, profondeur, statut'
      + ' (running/done/stopped/error), rate limit appliqué, dates. Lecture seule, ne lance rien.',
    inputSchema: {
      type: 'object',
      properties: {
        programId: { ...STR, description: 'identifiant du programme' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'nombre de scans renvoyés, défaut 20' },
      },
      required: ['programId'],
    },
    handler: async (args) => {
      const programId = asString(args.programId)
      if (!programId) return { text: 'programId requis (chaîne 1-200)', isError: true }
      const limit = args.limit === undefined ? 20 : asInt(args.limit, 1, 100)
      if (limit === null) return { text: 'limit doit être un entier entre 1 et 100', isError: true }
      const scans = getRepository()
        .listScans(programId)
        .slice(0, limit)
        .map((s) => ({
          id: s.id, depth: s.depth, status: s.status, rateLimit: s.rate_limit,
          roeConfirm: s.roe_confirm === 1, startedAt: s.started_at, finishedAt: s.finished_at,
        }))
      return { text: JSON.stringify({ programId, count: scans.length, scans }, null, 2), details: { count: scans.length } }
    },
  },
  {
    name: 'start_scan',
    description: "Lance un scan automatisé d'un programme selon les règles d'engagement : profils low/med/high"
      + ' (curl puis nuclei, voire ffuf). Ne cible que des cibles in-scope http(s) et respecte un rate limit.'
      + " Aucune confirmation manuelle (roeConfirm) n'est requise : le scan démarre directement. Ne soumet jamais de rapport.",
    inputSchema: {
      type: 'object',
      properties: {
        programId: STR,
        depth: { type: 'string', enum: ['low', 'med', 'high'] },
        roeConfirm: BOOL,
        rateLimit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['programId', 'depth'],
    },
    handler: async (args) => {
      const programId = asString(args.programId)
      const depth = args.depth === 'low' || args.depth === 'med' || args.depth === 'high' ? args.depth : null
      const roeConfirm = args.roeConfirm === true
      const rateLimit = asInt(args.rateLimit, 1, 50)
      if (!programId) return { text: 'programId requis', isError: true }
      if (!depth) return { text: 'depth doit être low, med ou high', isError: true }

      const repo = getRepository()
      try {
        let detail
        if (getClient().getToken()) {
          detail = await fetchProgramDetail(getClient(), programId)
        } else {
          detail = getCachedProgramDetail(programId)
        }
        if (!detail) return { text: 'Détail du programme indisponible', isError: true }
        const MAX_SCOPE_AGE_MS = 24 * 3600 * 1000
        if (Date.now() - detail.fetchedAt > MAX_SCOPE_AGE_MS) {
          return { text: 'Scope expiré : resynchronisez le programme (jeton requis) avant tout scan', isError: true }
        }
        if (detail.roe && detail.roe.automatedTooling === 0) {
          return { text: 'Les règles d’engagement interdisent les outils automatisés pour ce programme', isError: true }
        }
        if (activeScanForProgram(programId)) {
          return { text: 'Un scan est déjà en cours pour ce programme', isError: true }
        }
        if (activeScanCount() >= 2) {
          return { text: 'Trop de scans simultanés (max 2)', isError: true }
        }
        const targets = selectTargets(detail.scope)
        if (targets.length === 0) return { text: 'Aucune cible in-scope exploitable (http(s))', isError: true }
        if (targets.length > MAX_TARGETS) {
          return { text: `Scope trop large (${targets.length} cibles, max ${MAX_TARGETS}) — affinez le programme`, isError: true }
        }
        const rate = rateLimit ?? DEFAULT_RATE[depth]
        const scanId = repo.createScan({ programId, depth, rateLimit: rate, roeConfirm })
        const plan = buildPlan(depth, targets, rate, {
          userAgent: detail.roe?.userAgent,
          requestHeader: detail.roe?.requestHeader,
        })
        void startScan(scanId, plan)
        return { text: JSON.stringify({ ok: true, scanId, targets: targets.length, depth, rateLimit: rate }, null, 2) }
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
  },
  {
    name: 'get_scan',
    description: 'État courant d’un scan lancé par start_scan : statut (running/done/stopped/error), profondeur, rate limit.',
    inputSchema: { type: 'object', properties: { scanId: INT }, required: ['scanId'] },
    handler: async (args) => {
      const scanId = asInt(args.scanId, 1, Number.MAX_SAFE_INTEGER)
      if (!scanId) return { text: 'scanId entier requis', isError: true }
      const scan = getRepository().getScan(scanId)
      if (!scan) return { text: `Scan introuvable (id=${scanId})`, isError: true }
      return {
        text: JSON.stringify(
          {
            id: scan.id, programId: scan.program_id, depth: scan.depth, status: scan.status,
            rateLimit: scan.rate_limit, roeConfirm: scan.roe_confirm === 1,
            startedAt: scan.started_at, finishedAt: scan.finished_at,
          },
          null, 2
        ),
      }
    },
  },
  {
    name: 'scan_events',
    description: 'Logs événements d’un scan (curl/nuclei/ffuf exécutés). Reprendre avec afterSeq = dernier seq reçu'
      + ' pour ne recevoir que les nouveaux événements. done=true quand le scan est terminé.',
    inputSchema: {
      type: 'object',
      properties: { scanId: INT, afterSeq: { type: 'integer', minimum: 0 } },
      required: ['scanId'],
    },
    handler: async (args) => {
      const scanId = asInt(args.scanId, 1, Number.MAX_SAFE_INTEGER)
      if (!scanId) return { text: 'scanId entier requis', isError: true }
      const repo = getRepository()
      const scan = repo.getScan(scanId)
      if (!scan) return { text: `Scan introuvable (id=${scanId})`, isError: true }
      const afterSeq = asInt(args.afterSeq, 0, 1_000_000) ?? 0
      const events = repo.listScanEvents(scanId, afterSeq).map((r) => ({ seq: r.seq, ts: r.ts, level: r.level, message: r.message }))
      return { text: JSON.stringify({ events, done: scan.status !== 'running' }, null, 2) }
    },
  },
  {
    name: 'dedupe_findings',
    description: 'Normalise et dédoublonne des résultats bruts : extrait les URL http(s) de la sortie d’un scan'
      + ' (événements curl/nuclei/ffuf via scan_events) ou d’un texte collé, puis les regroupe par endpoint'
      + ' (hôte + chemin). Canonicalisation : casse de l’hôte, port par défaut, fragment et paramètres de suivi'
      + ' (utm_*, gclid, fbclid, msclkid, _ga) supprimés, query triée, slash final normalisé.'
      + ' Lecture seule, purely local : n’Envoie aucune requête et ne touche pas aux cibles. Plafonds : 500 événements'
      + ' de scan ou 500 lignes, 2000 caractères par ligne, 200 endpoints renvoyés.',
    inputSchema: {
      type: 'object',
      properties: {
        scanId: { ...INT, description: 'scan dont les événements servent de source (voir list_scans)' },
        lines: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 500,
          description: 'lignes de résultat brutes à analyser (alternative à scanId)',
        },
      },
    },
    handler: async (args) => {
      const repo = getRepository()
      const scanId = args.scanId === undefined ? null : asInt(args.scanId, 1, Number.MAX_SAFE_INTEGER)
      if (args.scanId !== undefined && scanId === null) return { text: 'scanId doit être un entier positif', isError: true }
      const rawLines = Array.isArray(args.lines) ? args.lines : []
      if (Array.isArray(args.lines) && rawLines.length > 500) return { text: 'lines : 500 lignes maximum', isError: true }
      if (scanId === null && rawLines.length === 0) {
        return { text: 'Fournir scanId ou lines : au moins une source de résultats est requise', isError: true }
      }

      const sources: Array<{ ref: string; line: string }> = []
      if (scanId !== null) {
        const scan = repo.getScan(scanId)
        if (!scan) return { text: `Scan introuvable (id=${scanId})`, isError: true }
        for (const ev of repo.listScanEvents(scanId, 0, 500)) {
          sources.push({ ref: `seq:${ev.seq}`, line: ev.message })
        }
      }
      for (const [i, line] of rawLines.entries()) {
        if (typeof line === 'string' && line.trim() !== '') sources.push({ ref: `ligne:${i + 1}`, line: line.slice(0, 2000) })
      }

      const groups = new Map<string, { endpoint: string; occurrences: number; variants: Set<string>; firstRef: string }>()
      const variantsTotal = new Set<string>()
      let found = 0
      for (const src of sources) {
        for (const rawUrl of extractUrls(src.line)) {
          const canon = canonicalizeUrl(rawUrl)
          if (!canon) continue
          found += 1
          variantsTotal.add(canon.url)
          const group = groups.get(canon.endpoint)
          if (group) {
            group.occurrences += 1
            group.variants.add(canon.url)
          } else {
            groups.set(canon.endpoint, {
              endpoint: canon.endpoint,
              occurrences: 1,
              variants: new Set([canon.url]),
              firstRef: src.ref,
            })
          }
        }
      }

      const ordered = [...groups.values()].sort((a, b) => b.occurrences - a.occurrences || a.endpoint.localeCompare(b.endpoint))
      const endpoints = ordered.slice(0, 200).map((g) => ({
        endpoint: g.endpoint,
        occurrences: g.occurrences,
        distinctUrls: g.variants.size,
        firstSeen: g.firstRef,
        urls: [...g.variants].slice(0, 20),
      }))
      return {
        text: JSON.stringify(
          {
            scanId,
            linesScanned: sources.length,
            urlsExtracted: found,
            uniqueUrls: variantsTotal.size,
            endpointsReturned: endpoints.length,
            endpointsOmitted: Math.max(0, ordered.length - endpoints.length),
            urlsTruncatedInGroups: ordered.some((g) => g.variants.size > 20),
            endpoints,
          },
          null,
          2,
        ),
        details: { urlsExtracted: found, uniqueUrls: variantsTotal.size, endpoints: ordered.length },
      }
    },
  },
  {
    name: 'cvss_score',
    description: 'Calcule le score de base CVSS v3.1 d’un vecteur (AV/AC/PR/UI/S/C/I/A) et renvoie score, sévérité'
      + ' et sous-scores Impact / Exploitabilité. Calcul pur et local, aucun appel réseau, aucun envoi.'
      + ' Les métriques temporelles et environnementales (E, RL, RC, CR/IR/AR, M*) sont acceptées mais ignorées :'
      + ' elles sont listées dans ignoredMetrics. Le préfixe « CVSS:3.1/ » est recommandé ; « CVSS:3.0 » est accepté'
      + ' (mêmes poids de base). Vecteur invalide ou métrique manquante => erreur, jamais de score estimé.',
    inputSchema: {
      type: 'object',
      properties: {
        vector: { ...STR, description: 'vecteur CVSS, ex. CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
      },
      required: ['vector'],
    },
    handler: async (args) => {
      const vector = asString(args.vector, 300)
      if (!vector) return { text: 'vector requis (chaîne 1-300)', isError: true }
      const out = computeCvssBase(vector)
      if (!out.ok) return { text: `Vecteur CVSS invalide : ${out.error}`, isError: true }
      return {
        text: JSON.stringify(
          {
            input: out.input,
            baseVector: out.baseVector,
            version: out.version,
            baseScore: out.baseScore,
            severity: out.severity,
            metrics: out.metrics,
            impactSubScore: out.iss,
            impact: out.impact,
            exploitability: out.exploitability,
            ignoredMetrics: out.ignoredMetrics,
          },
          null,
          2,
        ),
        details: { baseScore: out.baseScore, severity: out.severity },
      }
    },
  },
  {
    name: 'http_request',
    description:
      'Envoie une requête HTTP personnalisée (méthode, en-têtes, corps libres) vers une URL dont l’hôte appartient'
      + ' au scope in-scope d’un programme, pour tester une vulnérabilité (injection, IDOR, CSRF, upload, SSRF…).'
      + ' Aucune confirmation manuelle n’est requise : disponible d’emblée. Les cibles restent confinées aux hôtes'
      + ' in-scope du programme, sous-domaines inclus ; tout autre hôte est refusé.'
      + ' Bornes : http(s) uniquement, 1 MiB lus (max 2 MiB), 60 s de délai, redirections non suivies (le 3xx et son'
      + ' Location sont renvoyés). Aucun cookie ni Authorization n’est ajouté implicitement. Toute invocation est'
      + ' journalisée (Activité des IA). À n’utiliser que sur les cibles et selon les ROE du programme.',
    inputSchema: {
      type: 'object',
      properties: {
        programId: { ...STR, description: 'programme dont le scope autorise la cible' },
        url: { ...STR, description: 'URL absolue http(s) dont l’hôte est in-scope' },
        method: { type: 'string', enum: [...HTTP_METHODS], description: 'méthode HTTP, défaut GET' },
        headers: { type: 'object', description: 'en-têtes personnalisés (valeurs chaînes)' },
        body: { type: 'string', description: 'corps de la requête (POST/PUT/PATCH/DELETE)' },
        maxBytes: { type: 'integer', minimum: 1024, maximum: 2_097_152, description: 'octets lus au maximum, défaut 1 MiB' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 60_000, description: 'délai en ms, défaut 20000' },
      },
      required: ['programId', 'url'],
    },
    handler: async (args) => {
      const programId = asString(args.programId)
      if (!programId) return { text: 'programId requis (chaîne 1-200)', isError: true }
      const raw = asString(args.url, 2000)
      if (!raw) return { text: 'url requis (chaîne 1-2000)', isError: true }
      let u: URL
      try {
        u = new URL(raw)
      } catch {
        return { text: `URL invalide : ${raw}`, isError: true }
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { text: `Protocole refusé (${u.protocol}) : seuls http et https sont acceptés`, isError: true }
      }
      const method = (typeof args.method === 'string' ? args.method : 'GET').toUpperCase()
      if (!(HTTP_METHODS as readonly string[]).includes(method)) {
        return { text: `Méthode refusée : ${method} (attendu ${HTTP_METHODS.join(', ')})`, isError: true }
      }
      const detail = await resolveProgramDetail(programId)
      if (!detail) return { text: `Programme introuvable ou scope indisponible : ${programId}`, isError: true }
      if (detail.roe && detail.roe.automatedTooling === 0) {
        return { text: 'Les règles d’engagement interdisent les outils automatisés pour ce programme', isError: true }
      }
      if (!isUrlInScope(detail.scope, u)) {
        const allowed = inScopeHosts(detail.scope)
        return {
          text: `Hôte hors scope : ${u.hostname}. Cibles autorisées : ${allowed.join(', ') || '(aucune)'}`,
          isError: true,
        }
      }
      // Un programme peut déclarer un hôte privé en scope : on refuse quand même
      // (SSRF), puis on borne le débit pour ne pas violer les ROE ni saturer la cible.
      const refusal = await ssrfRefusal(u)
      if (refusal) return { text: refusal, isError: true }
      const maxBytes = args.maxBytes === undefined ? 1_048_576 : asInt(args.maxBytes, 1024, 2_097_152)
      if (maxBytes === null) return { text: 'maxBytes doit être un entier entre 1024 et 2097152', isError: true }
      const timeoutMs = args.timeoutMs === undefined ? 20_000 : asInt(args.timeoutMs, 1000, 60_000)
      if (timeoutMs === null) return { text: 'timeoutMs doit être un entier entre 1000 et 60000', isError: true }

      // En-tetes construits AVANT de consommer un jeton de debit : un nom
      // d'en-tete invalide doit renvoyer une erreur claire sans penaliser le quota.
      const headers = new Headers()
      if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
        try {
          for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
            if (typeof v === 'string') headers.set(k, v.slice(0, 2000))
            else if (typeof v === 'number') headers.set(k, String(v))
          }
        } catch (err) {
          return { text: `En-tête invalide : ${err instanceof Error ? err.message : String(err)}`, isError: true }
        }
      }
      let body: string | undefined
      if (typeof args.body === 'string' && args.body.length > 0) {
        if (method === 'GET' || method === 'HEAD') {
          return { text: `Un corps n’est pas permis avec ${method}`, isError: true }
        }
        body = args.body.slice(0, 100_000)
      }

      // Valide d'abord, borne le debit ensuite : une requete malformee ne doit
      // pas consommer le quota ni retarder un appel legitime.
      await httpRequestThrottle.acquire()

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const started = Date.now()
      let res: Response
      try {
        res = await fetch(u.toString(), { method, headers, body, redirect: 'manual', signal: controller.signal })
      } catch (err) {
        clearTimeout(timer)
        const aborted = err instanceof Error && err.name === 'AbortError'
        return {
          text: aborted ? `Délai dépassé (${timeoutMs} ms)` : `Requête échouée : ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
      let buf: Buffer
      let truncated: boolean
      try {
        // Lecture plafonnée en flux : `arrayBuffer()` chargeait le corps entier en
        // mémoire avant troncature, ce qu'une cible in-scope pouvait faire exploser.
        const capped = await readCapped(res, maxBytes)
        buf = capped.buf
        truncated = capped.truncated
      } catch (err) {
        return { text: `Lecture de la réponse échouée : ${err instanceof Error ? err.message : String(err)}`, isError: true }
      } finally {
        clearTimeout(timer)
      }
      const outHeaders: Record<string, string> = {}
      for (const [k, v] of res.headers) outHeaders[k] = v
      const text = buf.toString('utf8')
      return {
        text: JSON.stringify(
          {
            url: u.toString(),
            method,
            status: res.status,
            statusText: res.statusText,
            location: res.headers.get('location'),
            headers: outHeaders,
            bytes: buf.length,
            truncated,
            elapsedMs: Date.now() - started,
            body: text,
          },
          null,
          2,
        ),
        details: { status: res.status, bytes: buf.length, truncated },
      }
    },
  },
  {
    name: 'submit_report',
    description:
      'Assemble un rapport de vulnérabilité structuré (titre, sévérité/CVSS, description, étapes de reproduction,'
      + ' impact, remédiation, preuve) et l’écrit en Markdown sous le dossier de données de Venari, dans'
      + ' reports/<programId>/, prêt à transmettre. IMPORTANT : aucune soumission externe n’est effectuée — l’API'
      + ' chercheur d’Intigriti est en lecture seule (aucun endpoint public de soumission). Le rapport renvoyé est un'
      + ' fichier local ; la transmission reste manuelle. Renvoie le chemin absolu du fichier écrit.',
    inputSchema: {
      type: 'object',
      properties: {
        programId: { ...STR, description: 'programme concerné (doit exister localement)' },
        title: { ...STR, description: 'titre du rapport' },
        severity: { ...STR, description: 'niveau (info/low/medium/high/critical) ou vecteur CVSS' },
        asset: { ...STR, description: 'cible affectée (URL, endpoint)' },
        description: { type: 'string', description: 'description de la vulnérabilité' },
        steps: { type: 'string', description: 'étapes de reproduction' },
        impact: { type: 'string', description: 'impact concret' },
        remediation: { type: 'string', description: 'remédiation suggérée' },
        poc: { type: 'string', description: 'preuve (requête HTTP brute, sortie, capture)' },
      },
      required: ['programId', 'title', 'description'],
    },
    handler: async (args) => {
      const programId = asString(args.programId)
      const title = asString(args.title, 300)
      const description = typeof args.description === 'string' ? args.description.trim().slice(0, 50_000) : ''
      if (!programId) return { text: 'programId requis', isError: true }
      if (!title) return { text: 'title requis (chaîne 1-300)', isError: true }
      if (!description) return { text: 'description requise', isError: true }
      const prog = getRepository().getProgram(programId)
      if (!prog) return { text: `Programme inconnu : ${programId}`, isError: true }

      const opt = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
      const severity = asString(args.severity, 200) ?? 'non évaluée'
      const asset = opt(args.asset, 500)
      const steps = opt(args.steps, 20_000)
      const impact = opt(args.impact, 20_000)
      const remediation = opt(args.remediation, 20_000)
      const poc = opt(args.poc, 20_000)

      // Une cible fournie sous forme d'URL doit etre in-scope, comme pour
      // http_request : sans ce controle, un rapport pouvait documenter une
      // cible que le programme n'autorise pas.
      if (asset) {
        let assetUrl: URL | null = null
        try {
          assetUrl = new URL(asset)
        } catch {
          assetUrl = null
        }
        if (assetUrl && (assetUrl.protocol === 'http:' || assetUrl.protocol === 'https:')) {
          const detail = await resolveProgramDetail(programId)
          if (!detail) return { text: `Scope indisponible pour ${programId} : impossible de vérifier la cible`, isError: true }
          if (!isUrlInScope(detail.scope, assetUrl)) {
            return {
              text: `Cible hors scope : ${assetUrl.hostname}. Un rapport ne peut viser qu'un actif in-scope du programme.`,
              isError: true,
            }
          }
        }
      }

      const now = new Date()
      const stamp = now.toISOString().replace(/[:.]/g, '-')
      const slug = title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'rapport'
      const safeId = programId.replace(/[^a-z0-9._-]/gi, '_')
      if (safeId === '.' || safeId === '..' || safeId.length === 0) {
        return { text: `programId invalide : ${programId}`, isError: true }
      }
      const dir = join(app.getPath('userData'), 'reports', safeId)
      const file = join(dir, `${stamp}-${slug}.md`)
      const md = [
        `# ${title}`,
        '',
        `- Programme : ${prog.name} (\`${programId}\`)`,
        asset ? `- Cible : ${asset}` : null,
        `- Sévérité : ${severity}`,
        `- Généré : ${now.toISOString()}`,
        '',
        '## Description',
        '',
        description,
        steps ? `\n## Étapes de reproduction\n\n${steps}` : null,
        impact ? `\n## Impact\n\n${impact}` : null,
        poc ? `\n## Preuve (PoC)\n\n\`\`\`\n${poc}\n\`\`\`` : null,
        remediation ? `\n## Remédiation\n\n${remediation}` : null,
        '',
        '---',
        'Rapport généré par Venari. Aucune soumission automatique : l’API Intigriti est en lecture seule.',
        '',
      ]
        .filter((l): l is string => l !== null)
        .join('\n')

      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, md, 'utf8')
      } catch (err) {
        return { text: `Écriture du rapport échouée : ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
      // Le rapport devient un finding « rapporté » : c'est le lien entre la
      // chasse, le suivi et le fichier Markdown, sans double saisie.
      const repo = getRepository()
      const sev = normalizeSeverity(severity === 'non évaluée' ? null : severity)
      const relativeReport = `${safeId}/${`${stamp}-${slug}.md`}`
      const existing = repo.findDuplicateFinding(programId, asset, title)
      let findingId: number
      if (existing) {
        repo.updateFinding(existing.id, {
          status: 'reported',
          reportPath: relativeReport,
          description: description || existing.description,
          poc: poc || existing.poc,
          severity: existing.severity === 'info' ? sev.severity : existing.severity,
          cvss: existing.cvss ?? sev.cvss,
        })
        findingId = existing.id
      } else {
        findingId = repo.createFinding({
          programId,
          asset,
          title,
          severity: sev.severity,
          cvss: sev.cvss,
          status: 'reported',
          description,
          poc,
          scanId: null,
          reportPath: relativeReport,
        })
      }
      return {
        text: JSON.stringify(
          {
            ok: true,
            path: file,
            program: prog.name,
            title,
            severity,
            findingId,
            submitted: false,
            note: 'Rapport écrit localement ; soumission manuelle requise (API Intigriti en lecture seule).',
          },
          null,
          2,
        ),
        details: { path: file, submitted: false, findingId },
      }
    },
  },
  {
    name: 'record_finding',
    description:
      'Enregistre un finding dans le suivi local de Venari (le tableau Findings de l’application).'
      + ' Un finding identique (même programme, même cible, même titre à la casse près) est mis à jour au lieu'
      + ' d’être dupliqué : re-soumettre après un scan ne crée pas de doublon. Écriture locale uniquement,'
      + ' aucun appel réseau. Renvoie l’id et un drapeau `duplicate`.',
    inputSchema: {
      type: 'object',
      properties: {
        programId: { ...STR, description: 'programme concerné (doit exister localement)' },
        title: { ...STR, description: 'titre court du finding' },
        asset: { ...STR, description: 'cible affectée (URL, endpoint)' },
        severity: { ...STR, description: 'info/low/medium/high/critical, un score 0-10 ou un vecteur CVSS' },
        description: { type: 'string', description: 'description de la vulnérabilité' },
        poc: { type: 'string', description: 'preuve (requête, sortie, capture)' },
        scanId: { ...INT, description: 'scan d’origine, optionnel' },
      },
      required: ['programId', 'title'],
    },
    handler: async (args) => {
      const programId = asString(args.programId)
      const title = asString(args.title, 300)
      if (!programId) return { text: 'programId requis (chaîne 1-200)', isError: true }
      if (!title) return { text: 'title requis (chaîne 1-300)', isError: true }
      const repo = getRepository()
      if (!repo.getProgram(programId)) return { text: `Programme inconnu : ${programId}`, isError: true }
      const asset = typeof args.asset === 'string' ? args.asset.trim().slice(0, 500) : ''
      const rawSeverity = typeof args.severity === 'string' ? args.severity : null
      const sev = normalizeSeverity(rawSeverity)
      const description = typeof args.description === 'string' ? args.description.trim().slice(0, 50_000) : ''
      const poc = typeof args.poc === 'string' ? args.poc.trim().slice(0, 20_000) : ''
      const scanId = args.scanId === undefined ? null : asInt(args.scanId, 1, Number.MAX_SAFE_INTEGER)
      if (args.scanId !== undefined && scanId === null) return { text: 'scanId doit être un entier positif', isError: true }

      const duplicate = repo.findDuplicateFinding(programId, asset, title)
      if (duplicate) {
        repo.updateFinding(duplicate.id, {
          severity: sev.severity,
          cvss: sev.cvss ?? duplicate.cvss,
          description: description || duplicate.description,
          poc: poc || duplicate.poc,
        })
        return {
          text: JSON.stringify({ ok: true, id: duplicate.id, duplicate: true }, null, 2),
          details: { id: duplicate.id, duplicate: true },
        }
      }
      const id = repo.createFinding({
        programId,
        asset,
        title,
        severity: sev.severity,
        cvss: sev.cvss,
        status: 'open',
        description,
        poc,
        scanId,
        reportPath: null,
      })
      return {
        text: JSON.stringify({ ok: true, id, duplicate: false }, null, 2),
        details: { id, duplicate: false },
      }
    },
  },
  {
    name: 'list_findings',
    description:
      'Liste le suivi de findings local (tri par dernière mise à jour). Filtres optionnels par programme,'
      + ' statut (open/triaged/reported/fixed/duplicate/wontfix) et sévérité. Lecture seule.',
    inputSchema: {
      type: 'object',
      properties: {
        programId: STR,
        status: { type: 'string', enum: [...FINDING_STATUSES] },
        severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
        limit: { ...INT, description: '1-200, défaut 100' },
      },
    },
    handler: async (args) => {
      const status = typeof args.status === 'string' && (FINDING_STATUSES as readonly string[]).includes(args.status)
        ? args.status
        : undefined
      const severity = typeof args.severity === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(args.severity)
        ? args.severity
        : undefined
      const programId = args.programId === undefined ? undefined : (asString(args.programId) ?? undefined)
      if (args.programId !== undefined && !programId) return { text: 'programId invalide', isError: true }
      const limit = args.limit === undefined ? 100 : asInt(args.limit, 1, 200)
      if (limit === null) return { text: 'limit doit être un entier entre 1 et 200', isError: true }
      const rows = getRepository().listFindings({ programId, status, severity, limit }).map((f) => ({
        id: f.id,
        programId: f.program_id,
        program: f.program_name,
        title: f.title,
        asset: f.asset,
        severity: f.severity,
        cvss: f.cvss,
        status: f.status,
        reportPath: f.report_path,
        scanId: f.scan_id,
        updatedAt: f.updated_at,
      }))
      return { text: JSON.stringify({ findings: rows }, null, 2), details: { count: rows.length } }
    },
  },
  {
    name: 'update_finding',
    description: 'Met à jour un finding du suivi (statut, sévérité, CVSS, description, preuve). Renvoie le finding résultant.',
    inputSchema: {
      type: 'object',
      properties: {
        findingId: INT,
        status: { type: 'string', enum: [...FINDING_STATUSES] },
        severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
        cvss: { type: 'number', minimum: 0, maximum: 10 },
        description: { type: 'string' },
        poc: { type: 'string' },
      },
      required: ['findingId'],
    },
    handler: async (args) => {
      const findingId = asInt(args.findingId, 1, Number.MAX_SAFE_INTEGER)
      if (!findingId) return { text: 'findingId entier positif requis', isError: true }
      const repo = getRepository()
      const current = repo.getFinding(findingId)
      if (!current) return { text: `Finding introuvable (id=${findingId})`, isError: true }
      const status = typeof args.status === 'string' && (FINDING_STATUSES as readonly string[]).includes(args.status)
        ? args.status
        : undefined
      const severity = typeof args.severity === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(args.severity)
        ? args.severity
        : undefined
      const cvss = args.cvss === undefined ? undefined : typeof args.cvss === 'number' && args.cvss >= 0 && args.cvss <= 10 ? args.cvss : null
      if (args.cvss !== undefined && cvss === null) return { text: 'cvss doit être un nombre entre 0 et 10', isError: true }
      const description = typeof args.description === 'string' ? args.description.trim().slice(0, 50_000) : undefined
      const poc = typeof args.poc === 'string' ? args.poc.trim().slice(0, 20_000) : undefined
      try {
        repo.updateFinding(findingId, { status, severity, cvss, description: description || undefined, poc: poc || undefined })
      } catch (err) {
        return { text: `Mise à jour impossible : ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
      const f = repo.getFinding(findingId)
      return { text: JSON.stringify(f, null, 2), details: { findingId } }
    },
  },
  {
    name: 'list_reports',
    description:
      'Liste les rapports Markdown écrits par submit_report dans le dossier de données de Venari, du plus récent'
      + ' au plus ancien. Lecture seule.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const reports = listReports().slice(0, 200).map((r) => ({
        programId: r.programId,
        path: r.path,
        name: r.name,
        size: r.size,
        updatedAt: r.updatedAt,
      }))
      return { text: JSON.stringify({ reports }, null, 2), details: { count: reports.length } }
    },
  },
  {
    name: 'read_report',
    description:
      'Lit un rapport Markdown listé par list_reports (chemin relatif). Aperçu plafonné à 512 Ko ;'
      + ' `truncated` signale la troncature. Aucun accès hors du dossier de rapports.',
    inputSchema: {
      type: 'object',
      properties: { path: { ...STR, description: 'chemin relatif renvoyé par list_reports, ex. <programId>/<fichier>.md' } },
      required: ['path'],
    },
    handler: async (args) => {
      const relativePath = asString(args.path, 1000)
      if (!relativePath) return { text: 'path requis (chaîne 1-1000)', isError: true }
      const res = readReport(relativePath)
      if (!res.ok) return { text: res.error, isError: true }
      return { text: res.content, details: { path: relativePath, truncated: res.truncated } }
    },
  },
]

const TOOLS = TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))

let server: ReturnType<typeof createServer> | null = null
let currentPort: number | null = null
let currentLan = false
let currentTokens: string[] = []
let tokenLabels = new Map<string, string>()
let currentPairId: string | null = null

export type PairingRedeem = (code: string) => Promise<{ ok: true; token: string; label: string } | { ok: false; error: string }>

// Branche l'appairage sur le stockage : le serveur ne connait ni le coffre de
// jetons ni la config, il delegue la verification du code au processus principal.
let pairingRedeem: PairingRedeem | null = null

function labelFor(token: string): string {
  const known = tokenLabels.get(token)
  if (known) return known
  const guessed = currentTokens.indexOf(token)
  if (guessed !== -1) return `PC ${guessed + 1}`
  return ''
}

function localHosts(): string[] {
  const out: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address)
    }
  }
  return [...new Set(out)].sort()
}

export function isPrivateNetwork(): boolean {
  let saw = false
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      saw = true
      const parts = a.address.split('.')
      const first = Number(parts[0] ?? 0)
      const second = Number(parts[1] ?? 0)
      const priv =
        first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
      // Une seule interface publique (Wi-Fi public, VPN) rend l'exposition LAN
      // inacceptable : on exige que TOUTES les interfaces non-internes le soient,
      // sinon 0.0.0.0 exposerait le serveur au réseau public.
      if (!priv) return false
    }
  }
  return saw
}

export function generateMcpToken(): string {
  return randomBytes(24).toString('base64url')
}

export function generateMcpTokenId(): string {
  return randomBytes(6).toString('hex')
}

/**
 * Representation non reversible d'un jeton. On n'affiche aucun caractere du
 * secret : une empreinte SHA-256 tronquee laisse l'operateur distinguer deux
 * jetons sans divulguer le moindre bit exploitable.
 */
export function maskToken(token: string | null | undefined): string {
  if (!token) return ''
  const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 4)
  return `••••••••${fingerprint}`
}

/** Jeton en clair, pour le processus principal uniquement (jamais renvoye au renderer). */
export function getPrimaryMcpToken(): string | null {
  return currentTokens[0] ?? null
}

export function getMcpStatus(): McpStatusInfo {
  return {
    enabled: false,
    running: server !== null,
    port: currentPort,
    lan: currentLan,
    hosts: localHosts(),
    masked: maskToken(currentTokens[0]),
    tokens: currentTokens.map((t) => ({ id: labelFor(t) || '?', label: labelFor(t) || 'PC', masked: maskToken(t) })),
  }
}

/** Identifiant public du processus serveur, renvoye par la decouverte et l'appairage. */
export function getMcpPairId(): string | null {
  return currentPairId
}

export function setPairingRedeem(fn: PairingRedeem | null): void {
  pairingRedeem = fn
}

/**
 * Ajoute un jeton au serveur *deja en ecoute*, sans redemarrage : l'appairage
 * repond sur la connexion en cours, qu'un `closeServer()` interromprait.
 * La persistance reste a la charge de l'appelant.
 */
export function addMcpToken(token: string, label: string): void {
  currentTokens = [...currentTokens, token]
  tokenLabels.set(token, label)
}

export function setMcpTokens(tokens: string[], labels?: Map<string, string>): void {
  currentTokens = [...tokens]
  tokenLabels = labels ? new Map(labels) : new Map()
}

export function setMcpToken(token: string | null): void {
  currentTokens = token ? [token] : []
  tokenLabels = new Map()
}

/** Cles dont la valeur ne doit jamais atterrir dans le journal d'audit en clair. */
const SECRET_KEY = /authorization|cookie|proxy-authorization|x-api-key|api[-_]?key|token|secret|password|passwd|pwd/i

/** Recopie les arguments en masquant les valeurs sensibles (en-tetes, jetons). */
function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '***' : redactSecrets(v, depth + 1)
  }
  return out
}

function audit(tokenLabel: string, tool: string, args: unknown, status: string, ms: number, remoteIp = ''): void {
  try {
    getRepository().appendMcpRequest({
      ts: Date.now(),
      tokenLabel,
      tool,
      argsJson: typeof args === 'string' ? args : JSON.stringify(redactSecrets(args) ?? {}),
      status,
      ms,
      remoteIp,
    })
  } catch {
    // l'audit ne doit jamais faire planter une requête
  }
}

export async function callTool(name: string, args: ToolArgs): Promise<ToolResult> {
  const def = TOOL_DEFS.find((t) => t.name === name)
  if (!def) return { text: `Outil inconnu : ${name}`, isError: true }
  return def.handler(args)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = body !== undefined ? JSON.stringify(body) : ''
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function sendRpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result })
}

function sendRpcError(res: ServerResponse, id: unknown, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('payload trop gros'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function constantTimeEqual(header: string, expected: string): boolean {
  if (header.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

function authedToken(req: IncomingMessage): string | null {
  if (currentTokens.length === 0) return null
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return null
  const provided = header.slice(prefix.length)
  for (const token of currentTokens) {
    if (constantTimeEqual(provided, token)) return token
  }
  return null
}

/**
 * Un client MCP legitime (curl, SDK, agent distant) n'envoie pas d'en-tete de
 * contexte navigateur. La presence d'un Origin/Referer trahit un appel emis par
 * une page web (CSRF, DNS-rebinding) : on refuse avant meme l'authentification.
 */
function hasBrowserOrigin(req: IncomingMessage): boolean {
  return typeof req.headers.origin === 'string' || typeof req.headers.referer === 'string'
}

/** Bornes anti-bruteforce : des echecs d'authentification repetes depuis une meme IP. */
const AUTH_FAIL_LIMIT = 20
const AUTH_FAIL_WINDOW_MS = 60_000
const authFailures = new Map<string, { count: number; resetAt: number }>()

function tooManyAuthFailures(ip: string): boolean {
  const entry = authFailures.get(ip)
  if (!entry) return false
  if (Date.now() >= entry.resetAt) {
    authFailures.delete(ip)
    return false
  }
  return entry.count >= AUTH_FAIL_LIMIT
}

function noteAuthFailure(ip: string): void {
  const now = Date.now()
  const entry = authFailures.get(ip)
  if (!entry || now >= entry.resetAt) {
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS })
    return
  }
  entry.count += 1
}

/** Remet a zero le compteur d'echecs d'authentification (arret du serveur, tests). */
export function resetMcpAuthFailures(): void {
  authFailures.clear()
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // Decouverte : document public, sans jeton, qui expose de quoi appairer un
  // poste (pairId, port, hotes). Aucun secret n'y figure.
  if (url.pathname === '/.well-known/venari.json') {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' })
      res.end()
      return
    }
    sendJson(res, 200, {
      app: 'Venari',
      version: pkg.version,
      pairId: currentPairId,
      port: currentPort,
      lan: currentLan,
      hosts: localHosts(),
      pairing: currentPairId !== null,
      mcp: '/mcp',
    })
    return
  }
  // Appairage : echange un code a usage unique contre un jeton dedie. Le code
  // est verifie par le processus principal (TTL + tentatives), pas ici.
  if (url.pathname === '/pair') {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' })
      res.end()
      return
    }
    if (!req.headers['content-type']?.startsWith('application/json')) {
      sendJson(res, 415, { ok: false, error: 'content-type application/json requis' })
      return
    }
    if (!pairingRedeem) {
      sendJson(res, 503, { ok: false, error: 'Appairage indisponible sur ce serveur.' })
      return
    }
    let code = ''
    try {
      const parsed = JSON.parse(await readBody(req)) as { code?: unknown }
      if (typeof parsed.code === 'string') code = parsed.code
    } catch {
      sendJson(res, 400, { ok: false, error: 'JSON invalide' })
      return
    }
    if (!code) {
      sendJson(res, 400, { ok: false, error: 'Code manquant.' })
      return
    }
    const result = await pairingRedeem(code)
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error })
      return
    }
    sendJson(res, 200, {
      ok: true,
      token: result.token,
      label: result.label,
      port: currentPort,
      lan: currentLan,
      hosts: localHosts(),
      mcp: '/mcp',
    })
    return
  }
  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' })
    res.end()
    return
  }
  if (hasBrowserOrigin(req)) {
    sendJson(res, 403, { error: 'requete navigateur refusee' })
    return
  }
  if (!req.headers['content-type']?.startsWith('application/json')) {
    sendJson(res, 415, { error: 'content-type application/json requis' })
    return
  }
  const remoteIp = req.socket.remoteAddress ?? ''
  if (tooManyAuthFailures(remoteIp)) {
    sendJson(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32002, message: 'Too Many Requests' } })
    return
  }
  const authed = authedToken(req)
  if (!authed) {
    noteAuthFailure(remoteIp)
    audit('', '_unauthorized', {}, '401', 0, remoteIp)
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } })
    return
  }
  const clientLabel = labelFor(authed)

  let parsed: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
  try {
    parsed = JSON.parse(await readBody(req)) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
  } catch {
    sendJson(res, 400, { error: 'JSON invalide' })
    return
  }
  if (typeof parsed.method !== 'string') {
    sendJson(res, 400, { error: 'méthode JSON-RPC manquante' })
    return
  }

  const id = 'id' in parsed ? parsed.id : undefined
  const isNotification = id === undefined
  if (parsed.method === 'notifications/initialized') {
    res.writeHead(202, { 'Content-Length': '0' })
    res.end()
    return
  }
  if (isNotification) {
    res.writeHead(202, { 'Content-Length': '0' })
    res.end()
    return
  }

  switch (parsed.method) {
    case 'initialize': {
      sendRpcResult(res, id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'Venari', version: pkg.version },
      })
      return
    }
    case 'ping': {
      sendRpcResult(res, id, {})
      return
    }
    case 'tools/list': {
      sendRpcResult(res, id, { tools: TOOLS })
      return
    }
    case 'tools/call': {
      const params = (parsed.params ?? {}) as { name?: unknown; arguments?: unknown }
      const name = typeof params.name === 'string' ? params.name : ''
      const toolArgs = params.arguments && typeof params.arguments === 'object' ? (params.arguments as ToolArgs) : {}
      const start = Date.now()
      let result: ToolResult
      try {
        result = await callTool(name, toolArgs)
      } catch (err) {
        // Un handler qui jette ne doit pas se transformer en 500 muet : on le
        // remonte comme resultat d'outil en erreur (visible par le client MCP)
        // pour conserver la ligne d'audit et un message exploitable.
        result = { text: err instanceof Error ? err.message : String(err), isError: true }
      }
      const ms = Date.now() - start
      audit(clientLabel, name || '«tool manquant»', toolArgs, result.isError === true ? 'error' : 'ok', ms, remoteIp)
      sendRpcResult(res, id, { content: [{ type: 'text', text: result.text }], isError: result.isError === true })
      return
    }
    default:
      sendRpcError(res, id, -32601, `Méthode inconnue : ${parsed.method}`)
  }
}

function closeServer(): Promise<void> {
  const s = server
  server = null
  currentPort = null
  currentLan = false
  currentTokens = []
  tokenLabels = new Map()
  authFailures.clear()
  currentPairId = null
  stopDiscoveryResponder()
  closeAgents()
  if (!s) return Promise.resolve()
  return new Promise((resolve) => {
    s.close(() => resolve())
    s.closeAllConnections?.()
  })
}

export async function startMcpServer(
  port: number,
  token: string,
  opts?: {
    lan?: boolean
    tokens?: string[]
    tokenLabels?: Map<string, string>
    agentTokens?: string[] | AgentAuthEntry[]
    /** Port UDP de decouverte ; 0 = ephemere (tests). Defaut : DISCOVERY_PORT. */
    discoveryPort?: number
  }
): Promise<{ ok: true; port: number; discoveryPort: number } | { ok: false; error: string }> {
  await closeServer()
  return new Promise((resolve) => {
    const tokens = opts?.tokens && opts.tokens.length > 0 ? [...opts.tokens] : [token]
    currentTokens = tokens
    tokenLabels = opts?.tokenLabels ? new Map(opts.tokenLabels) : new Map()
    // Garde unique et non contournable : 0.0.0.0 n'est autorise que sur un
    // reseau prive. Aucun appelant (y compris un renderer compromis qui
    // demanderait lan=true) ne peut exposer le serveur sur un reseau public.
    currentLan = opts?.lan === true && isPrivateNetwork()
    const host = currentLan ? '0.0.0.0' : '127.0.0.1'
    const rawAgents = opts?.agentTokens
    const agentEntries: AgentAuthEntry[] = Array.isArray(rawAgents)
      ? (rawAgents as AgentAuthEntry[]).every((a) => typeof a === 'object' && a && 'token' in a)
        ? (rawAgents as AgentAuthEntry[])
        : (rawAgents as string[]).map((t, i) => ({ id: `agent-${i + 1}`, label: `Agent ${i + 1}`, token: t }))
      : []
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      void route(req, res).catch(() => {
        sendJson(res, 500, { error: 'internal error' })
      })
    })
    attachAgentsToServer(srv)
    srv.once('error', (err: Error & { code?: string }) => {
      currentTokens = []
      tokenLabels = new Map()
      currentLan = false
      currentPairId = null
      stopDiscoveryResponder()
      // Le serveur n'a jamais écouté : `server` n'est pas renseigné, donc
      // closeServer() ne nettoiera pas les timers/WSS montés par
      // attachAgentsToServer — on les referme ici, sinon ils restent actifs.
      closeAgents()
      // Résolution et non rejection : l'appelant (McpSetEnabled) lit
      // `started.ok`, et un rejet transportant un objet non-Error se
      // transformait en « [object Object] » côté utilisateur.
      resolve({
        ok: false,
        error: err.code === 'EADDRINUSE' ? `Port ${port} déjà utilisé` : err.message,
      })
    })
    srv.listen(port, host, () => {
      server = srv
      currentLan = host === '0.0.0.0'
      const addr = srv.address()
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port
      currentPort = actualPort
      // Identifiant public du processus, regenere a chaque demarrage : la
      // decouverte et l'appairage designent la meme instance, sans exposer de secret.
      currentPairId = randomBytes(6).toString('base64url')
      void startDiscoveryResponder(
        () => ({
          app: 'Venari',
          version: pkg.version,
          pairId: currentPairId,
          port: actualPort,
          lan: currentLan,
          hosts: localHosts(),
          pairing: true,
          mcp: '/mcp',
        }),
        opts?.discoveryPort ?? DISCOVERY_PORT
      ).then((discoveryPort) => {
        configureAgents(agentEntries)
        resolve({ ok: true, port: actualPort, discoveryPort })
      })
    })
  })
}

export function stopMcpServer(): void {
  void closeServer()
}