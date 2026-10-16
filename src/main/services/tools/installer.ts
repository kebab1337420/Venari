import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { app } from 'electron'
import pkg from '../../../../package.json'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import type { ToolEntry } from '../../../shared/ipc'
import { getTool, TOOL_CATALOG, type ToolDefinition, type ToolInstallationResult } from './catalog'
import { isChecksumAsset, parseChecksums, safeEqualHex, sha256File } from './integrity'
import { loadGithubToken } from '../../storage'
import {
  assetFilterFor,
  exeCandidates,
  hasPortableBinary,
  isWindows,
  makeExecutable,
  portableBinaryName,
  releaseTarget,
  selectReleaseAsset
} from './platform'
import { killTree } from '../proc'

export function toolsDir(): string {
  const dir = join(app.getPath('userData'), 'tools')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Chemin du binaire portable pour un outil (suffixe et nom réels selon la plateforme). */
export function portableExePath(id: string, exeName?: string): string {
  const tool = getTool(id)
  return join(toolsDir(), id, portableBinaryName(id, exeName ?? tool?.exeName))
}

const GITHUB_ASSET_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
])

function assertGithubAssetUrl(raw: string): void {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`URL d'asset invalide`)
  }
  if (u.protocol !== 'https:' || !GITHUB_ASSET_HOSTS.has(u.hostname)) {
    throw new Error(`Hôte d'asset non autorisé : ${u.hostname}`)
  }
}

export function resolveBinary(tool: string): string | null {
  if (!/^[a-z0-9][a-z0-9._-]{0,59}$/i.test(tool) || !getTool(tool)) return null
  const def = getTool(tool)
  if (def?.source === 'pip') {
    // Les binaires vivent dans le venv, pas dans le dossier de l'outil :
    // exeCandidates ne peut pas les trouver seul.
    const script = pipScriptPath(def)
    return existsSync(script) ? script : null
  }
  const dir = join(toolsDir(), tool)
  for (const name of exeCandidates(tool, getTool(tool)?.exeName)) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Chemin du script console créé par pip dans le venv isolé d'un outil. */
function pipScriptPath(tool: ToolDefinition): string {
  const stem = tool.exeName ?? tool.id
  return isWindows()
    ? join(toolsDir(), tool.id, '.venv', 'Scripts', `${stem}.exe`)
    : join(toolsDir(), tool.id, '.venv', 'bin', stem)
}

export function resolveWordlist(tool = 'seclists'): string | null {
  const base = join(toolsDir(), tool)
  for (const rel of [
    'Discovery/Web-Content/raft-medium-words.txt',
    'Discovery/Web-Content/directory-list-2.3-medium.txt'
  ]) {
    const candidate = join(base, rel)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function gitPkgPath(id: string): string {
  return join(toolsDir(), id)
}

const MARKER = '.bountydesk-installed'

/** Outils en cours d'installation : protege leur dossier des purges residues. */
const activeInstalls = new Set<string>()

/**
 * Les gestionnaires de paquets système (winget, apt) verrouillent leur source
 * et leur base locale : deux installations simultanées se marchent dessus.
 * On les sérialise pendant que les téléchargements GitHub, les clonages et les
 * environnements uv, eux, avancent bien en parallèle.
 */
let systemInstalls: Promise<unknown> = Promise.resolve()
export function withSystemInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = systemInstalls.then(fn, fn)
  systemInstalls = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

/**
 * Purge les archives et repertoires temporaires abandonnes par une
 * installation interrompue (coupure, plantage, fermeture de l'app). Appele au
 * demarrage : ces residus peuvent peser plusieurs centaines de Mo.
 */
export function purgeInstallResidues(): number {
  let removed = 0
  let entries: string[]
  try {
    entries = readdirSync(toolsDir())
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(toolsDir(), entry)
    const m = /^([a-z0-9._-]+)\.(download\.(?:zip|tar\.gz)|tmp)$/i.exec(entry)
    if (!m) continue
    if (activeInstalls.has(m[1]!.toLowerCase())) continue
    try {
      rmSync(full, { recursive: true, force: true, maxRetries: 3 })
      removed++
    } catch {
      // Fichier verrouille par un antivirus : on retentera au prochain demarrage.
    }
  }
  return removed
}

async function rmRetry(dir: string, attempts = 4): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      return
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, 400))
    }
  }
}

async function isGitRepoCloned(dest: string): Promise<boolean> {
  if (!existsSync(join(dest, '.git'))) return false
  try {
  const code = await run('git', ['-C', dest, 'rev-parse', '--verify', 'HEAD'], undefined, DETECT_TIMEOUT_MS)
      return code === 0
  } catch {
    return false
  }
}

const RUN_TIMEOUT_MS = 5 * 60 * 1000
const DETECT_TIMEOUT_MS = 10 * 1000
const MAX_ASSET_BYTES = 512 * 1024 * 1024
/** Plus de progression pendant 60 s = connexion morte : on coupe. */
const DOWNLOAD_IDLE_MS = 60 * 1000
/** Plafond global d'un téléchargement : 512 Mo dans le temps ≈ 4,5 Mbit/s. */
const DOWNLOAD_TOTAL_MS = 15 * 60 * 1000
/** Appels API GitHub : n'ont que des en-têtes à lire, 30 s suffisent. */
const API_TIMEOUT_MS = 30 * 1000
/** Code de retour distingue d'un echec : l'appel a depasse son budget de temps. */
const TIMEOUT_CODE = -2

type Spawn = { cmd: string; args: string[] }

function killOnTimeout(child: ReturnType<typeof spawn>, ms: number): () => boolean {
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // winget, uv et git lancent leurs propres enfants : ne tuer que le pid
    // direct laisserait une installation continuer en arrière-plan.
    killTree(child)
  }, ms)
  timer.unref?.()
  return () => {
    clearTimeout(timer)
    return timedOut
  }
}

/**
 * Resout un nom de binaire nu en chemin absolu via PATH. Indispensable avant
 * spawn : sous Windows, CreateProcess cherche d'abord dans le repertoire
 * courant — et le dossier tools est inscriptible par `run_tool`. Un faux
 * git.exe/tar.exe/git y detournerait l'installation. Un chemin deja absolu ou
 * contenant un separateur (binaire du catalogue resolu) est laisse tel quel.
 */
function resolveSystemBin(name: string): string | null {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  const exts = isWindows()
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.trim()).filter(Boolean)
    : ['']
  for (const entry of raw.split(delimiter)) {
    const dir = entry.replace(/^"|"$/g, '')
    if (!dir || !isAbsolutePath(dir)) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // absent de ce dossier : on continue
      }
    }
  }
  return null
}

function resolveCmd(cmd: string): string {
  if (/[\\/]/.test(cmd)) return cmd
  return resolveSystemBin(cmd) ?? cmd
}

function run(
  cmd: string,
  args: string[],
  onOutput?: (line: string) => void,
  timeoutMs = RUN_TIMEOUT_MS,
  env?: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCmd(cmd), args, {
      windowsHide: true,
      shell: false,
      // POSIX : enfant meneur de son groupe, pour que killTree vise toute la
      // descendance (git appelle ssh, uv peut relancer des scripts).
      detached: process.platform !== 'win32',
      cwd: toolsDir(),
      env: env ? { ...process.env, ...env } : undefined
    })
    const timedOut = killOnTimeout(child, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => onOutput?.(b.toString()))
    child.stderr?.on('data', (b: Buffer) => onOutput?.(b.toString()))
    child.on('error', (err) => {
      timedOut()
      reject(err)
    })
    child.on('close', (code) => resolve(timedOut() ? TIMEOUT_CODE : code ?? -1))
  })
}

/** Variante qui capture stdout : sert a resoudre un chemin sans executer la cible. */
function runCapture({ cmd, args }: Spawn, timeoutMs = DETECT_TIMEOUT_MS): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(resolveCmd(cmd), args, {
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      cwd: toolsDir()
    })
    const timedOut = killOnTimeout(child, timeoutMs)
    let stdout = ''
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString()
    })
    child.stderr?.resume()
    child.on('error', () => {
      timedOut()
      resolve({ code: -1, stdout: '' })
    })
    child.on('close', (code) => resolve({ code: timedOut() ? TIMEOUT_CODE : code ?? -1, stdout }))
  })
}

function platformLabel(): string {
  return releaseTarget()
}

/**
 * Un outil installe dans le PATH du systeme est considere comme present.
 * Le PATH est lu une seule fois au lieu d'un `where.exe` par outil (70 ms
 * chacun, soit 8 s sur les 122 cibles winget du catalogue). Comme precedemment,
 * aucun binaire n'est execute : on ne lit que des repertoires.
 */
let pathIndex: { key: string; names: Set<string> } | null = null

export function pathExecutableNames(): Set<string> {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  if (pathIndex?.key === raw) return pathIndex.names
  const names = new Set<string>()
  const exts = isWindows()
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    : []
  for (const entry of raw.split(delimiter)) {
    const dir = entry.replace(/^"|"$/g, '')
    if (!dir || !isAbsolutePath(dir)) continue
    let files
    try {
      files = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // repertoire illisible (droits, lien mort)
    }
    for (const file of files) {
      if (!file.isFile() && !file.isSymbolicLink()) continue
      const name = file.name.toLowerCase()
      const ext = exts.find((e) => name.endsWith(e))
      names.add(ext ? name.slice(0, -ext.length) : name)
    }
  }
  pathIndex = { key: raw, names }
  return names
}

async function detectedOnPath(tool: ToolDefinition, probe?: string): Promise<boolean> {
  const name = probe ?? tool.detectCmd
  if (!name) return false
  return pathExecutableNames().has(name.toLowerCase())
}

function isAbsolutePath(p: string): boolean {
  if (isWindows()) return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
  return p.startsWith('/')
}

/**
 * Une seule enumeration `winget list` pour tout le catalogue : l'appel
 * unitaire `winget list --exact --id` coute ~900 ms, soit 105 s sur les 122
 * cibles winget. Retourne null si l'enumeration echoue, pour conserver le
 * repli unitaire d'origine.
 */
let wingetIds: { value: Set<string>; at: number } | null = null

function resetWingetDetection(): void {
  wingetIds = null
}

async function installedWingetIds(): Promise<Set<string> | null> {
  if (!isWindows()) return null
  if (wingetIds && Date.now() - wingetIds.at < 60_000) return wingetIds.value
  let captured: { code: number; stdout: string }
  try {
    captured = await runCapture({ cmd: 'winget', args: ['list'] }, 60_000)
  } catch {
    return null
  }
  if (captured.code !== 0) return null
  const value = new Set(captured.stdout.toLowerCase().split(/\s+/).filter(Boolean))
  wingetIds = { value, at: Date.now() }
  return value
}

export async function isInstalled(tool: ToolDefinition): Promise<boolean> {
  if (tool.source === 'winget' && tool.wingetId) {
    // Détection d'abord : fonctionne sur les deux plateformes sans privilèges.
    if (await detectedOnPath(tool)) return true
    if (!isWindows()) {
      // winget n'existe pas sous Linux. Sans paquet apt connu, on ne peut rien faire
      // de non-interactif ; l'utilisateur installe l'outil lui-même.
      return false
    }
    const installed = await installedWingetIds()
    if (installed) {
      // winget affiche `ARP\...` dans la colonne ID pour les apps installees
      // hors winget (Burp Suite installé à la main) : leur id n'y figure pas, leur nom si.
      // On teste donc l'id, l'id winget, la commande et le nom.
      const keys = [tool.wingetId, tool.id, tool.detectCmd, tool.exeName, tool.name]
        .filter((k): k is string => Boolean(k))
        .map((k) => k.toLowerCase())
      return keys.some((k) => installed.has(k))
    }
    const code = await run('winget', ['list', '--exact', '--id', tool.wingetId], undefined, DETECT_TIMEOUT_MS)
    return code === 0
  }
  if (tool.source === 'github') {
    if (await hasPortableBinary(toolsDir(), tool)) return true
    // Un outil installe via apt (repli Linux) vit dans le PATH systeme et n'a
    // aucun binaire portable : sans ce test il semblerait installe en permanence,
    // et chaque relance relancerait l'installation.
    if (!isWindows() && tool.aptPackage) {
      return detectedOnPath(tool, tool.exeName ?? tool.id)
    }
    return false
  }
  if (tool.source === 'git') {
    return existsSync(join(gitPkgPath(tool.id), MARKER))
  }
  if (tool.source === 'go') {
    // go install pose le binaire dans GOBIN = tools/<id> : détection identique
    // à une archive portable téléchargée.
    return hasPortableBinary(toolsDir(), tool)
  }
  if (tool.source === 'pip') {
    return existsSync(pipScriptPath(tool))
  }
  return false
}

export async function currentTools(): Promise<ToolEntry[]> {
  // Une actualisation doit refléter l'état réel : on repart d'une enumeration fraiche.
  resetWingetDetection()
  const tools: ToolEntry[] = []
  for (const def of TOOL_CATALOG) {
    let installed = false
    try {
      installed = await isInstalled(def)
    } catch {
      installed = false
    }
    tools.push({
      id: def.id,
      name: def.name,
      description: def.description,
      category: def.category,
      source: def.source,
      installed,
      defaultChecked: def.defaultChecked,
      docs: def.githubRepo ? `https://github.com/${def.githubRepo}` : undefined,
      windowsOnly: def.windowsOnly,
      guiOnly: def.guiOnly,
    })
  }
  return tools
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? loadGithubToken()
  const userAgent = `Venari/${pkg.version}`
  if (!token) return { 'User-Agent': userAgent }
  return { 'User-Agent': userAgent, Authorization: `Bearer ${token}` }
}

/**
 * Telecharge un asset GitHub en ecrivant sur disque progressively : on ne
 * charge jamais l'archive en memoire et on refuse un corps plus gros que la
 * limite, que l'en-tete content-length soit absent ou menteur.
 */
async function downloadToFile(url: string, dest: string): Promise<void> {
  // Un fetch sans garde-fou reste bloqué indéfiniment quand la connexion meurt
  // sans fin de trame : l'installation n'en sort jamais, d'où le « lente à
  // mourir ». Un plancher de progression coupe tôt, un plafond coupe sûr.
  const ctrl = new AbortController()
  const startedAt = Date.now()
  let lastProgress = Date.now()
  let stall: string | null = null
  const watchdog = setInterval(() => {
    if (stall) return
    const now = Date.now()
    if (now - lastProgress > DOWNLOAD_IDLE_MS) {
      stall = `Téléchargement interrompu : plus de progression depuis ${DOWNLOAD_IDLE_MS / 1000} s.`
    } else if (now - startedAt > DOWNLOAD_TOTAL_MS) {
      stall = `Téléchargement interrompu : délai total de ${DOWNLOAD_TOTAL_MS / 60000} min dépassé.`
    }
    if (stall) ctrl.abort()
  }, 2000)
  let file: ReturnType<typeof createWriteStream> | null = null
  try {
    const res = await fetch(url, { headers: githubHeaders(), signal: ctrl.signal })
    if (!res.ok) throw new Error(`Téléchargement refusé (HTTP ${res.status})`)
    assertGithubAssetUrl(res.url || url)
    lastProgress = Date.now()
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
      throw new Error(`Archive refusée : ${Math.round(declared / 1048576)} Mo dépassent la limite`)
    }
    if (!res.body) throw new Error('Réponse sans corps')
    file = createWriteStream(dest)
    let total = 0
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      lastProgress = Date.now()
      total += chunk.byteLength
      if (total > MAX_ASSET_BYTES) throw new Error('Archive refusée : limite de taille dépassée')
      if (!file.write(chunk)) await once(file, 'drain')
    }
    file.end()
    await once(file, 'close')
    if (total === 0) throw new Error('Archive vide')
  } catch (err) {
    file?.destroy()
    rmSync(dest, { force: true })
    throw stall ? new Error(stall) : err
  } finally {
    clearInterval(watchdog)
  }
}

/** @deprecated Utiliser selectReleaseAsset de ./platform. Conservé pour les tests existants. */
export function selectWindowsAsset(
  repo: string,
  want: string,
  assets: { name: string; browser_download_url: string }[] | undefined
): string {
  return selectReleaseAsset(repo, want, assets, 'windows')
}

/** Extrait une archive en routant sur l'outil adapté à son format réel. */
/** Liste les entrees d'une archive sans l'extraire, avec les memes outils que l'extraction. */
async function listArchiveEntries(archive: string): Promise<string[] | null> {
  const isZip = /\.zip$/i.test(archive)
  const attempts: Spawn[] = isZip
    ? [
        { cmd: 'tar', args: ['-tf', archive] },
        { cmd: 'unzip', args: ['-Z1', archive] }
      ]
    : [{ cmd: 'tar', args: ['-tf', archive] }]

  for (const attempt of attempts) {
    let captured: { code: number; stdout: string }
    try {
      captured = await runCapture(attempt)
    } catch {
      continue // binaire absent sur cette plateforme
    }
    if (captured.code === 0) {
      return captured.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    }
  }
  return null
}

/** Motif de refus d'une entree d'archive, ou null si elle reste dans la destination. */
export function unsafeArchiveEntry(entry: string): string | null {
  const normalized = entry.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    return `chemin absolu hors dossier de destination (${entry})`
  }
  if (normalized.split('/').includes('..')) {
    return `entree hors dossier de destination (${entry})`
  }
  return null
}

/** Refuse une archive dont une entree s'echapperait du dossier de destination. */
export async function assertStaysInside(archive: string): Promise<void> {
  const entries = await listArchiveEntries(archive)
  // Echec ferme : si on ne peut pas lister l'archive, on ne peut pas garantir
  // l'absence de traversee, donc on refuse plutot que d'installer a l'aveugle.
  if (!entries) {
    throw new Error('Archive refusee : contenu illisible, verification anti-traversee impossible')
  }
  for (const entry of entries) {
    const reason = unsafeArchiveEntry(entry)
    if (reason) throw new Error(`Archive refusee : ${reason}`)
  }
}

async function extractArchive(archive: string, dest: string, onOutput: (line: string) => void): Promise<void> {
  await assertStaysInside(archive)
  const isZip = /\.zip$/i.test(archive)
  // tar de GNU (Linux) ne gère pas le zip ; bsdtar (Windows 10+) le gère.
  const attempts: Spawn[] = isZip
    ? [
        { cmd: 'tar', args: ['-xf', archive, '-C', dest] },
        { cmd: 'unzip', args: ['-o', '-q', archive, '-d', dest] }
      ]
    : [{ cmd: 'tar', args: ['-xf', archive, '-C', dest] }]

  for (const attempt of attempts) {
    let code: number
    try {
      code = await run(attempt.cmd, attempt.args, onOutput)
    } catch {
      continue // binaire absent sur cette plateforme
    }
    if (code === 0) return
    if (code === TIMEOUT_CODE) throw new Error('Extraction interrompue (délai dépassé)')
  }
  throw new Error('Extraction échouée')
}

/** Telecharge un petit fichier texte (checksums) en plafonnant la taille. */
async function downloadText(url: string, maxBytes = 1024 * 1024): Promise<string> {
  const res = await fetch(url, { headers: githubHeaders(), signal: AbortSignal.timeout(API_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Téléchargement refusé (HTTP ${res.status})`)
  assertGithubAssetUrl(res.url || url)
  const contentLength = res.headers.get('content-length')
  if (contentLength) {
    const cl = Number(contentLength)
    if (!Number.isNaN(cl) && cl > maxBytes) {
      throw new Error('Fichier de sommes de contrôle trop volumineux')
    }
  }
  if (!res.body) throw new Error('Réponse vide')
  // Lecture par morceaux avec plafond : un serveur qui ignore content-length
  // (ou qui ment sur sa taille) ne peut pas faire gonfler la mémoire à volonté.
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error('Fichier de sommes de contrôle trop volumineux')
    }
    chunks.push(value)
  }
  const buf = Buffer.concat(chunks)
  return buf.toString('utf8')
}

/**
 * Verifie l'archive contre le fichier de sommes de controle de la release.
 * Si le projet n'en publie pas, on l'annonce franchement plutot que de
 * pretendre avoir verifie : l'utilisateur decide en connaissance de cause.
 */
async function verifyArchive(
  tool: ToolDefinition,
  archivePath: string,
  assetName: string,
  assets: { name: string; browser_download_url: string }[],
  onOutput: (line: string) => void
): Promise<string | null> {
  const sumAsset = assets.find((a) => isChecksumAsset(a.name))
  const digest = await sha256File(archivePath)
  if (!sumAsset) {
    onOutput(`Aucun fichier de sommes de contrôle dans la release de ${tool.githubRepo} : binaire non vérifié.`)
    return null
  }
  assertGithubAssetUrl(sumAsset.browser_download_url)
  const sums = parseChecksums(await downloadText(sumAsset.browser_download_url))
  const expected = sums.get(basename(assetName).toLowerCase())
  if (!expected) throw new Error(`Somme de contrôle absente de ${sumAsset.name} pour ${assetName}`)
  if (!safeEqualHex(expected, digest)) {
    throw new Error(`Somme de contrôle invalide pour ${assetName} : archive refusee.`)
  }
  onOutput(`Somme de contrôle vérifiée (SHA-256 ${digest.slice(0, 12)}…).`)
  return digest
}

/**
 * Certaines releases Github n'imbriquent qu'une archive (ex rustscan :
 * x86_64-linux-rustscan.tar.gz.zip contient un .tar.gz). On extracte récursivement
 * tant qu'on ne voit pas le binaire attendu.
 */
async function extractUntilBinary(
  archive: string,
  dest: string,
  wanted: string[],
  onOutput: (line: string) => void,
  depth = 0
): Promise<void> {
  await extractArchive(archive, dest, onOutput)
  if (findFile(dest, (n) => wanted.includes(n.toLowerCase()))) return
  if (depth >= 2) return
  for (const entry of readdirRecursive(dest)) {
    if (/\.(zip|tar\.gz|tgz)$/i.test(entry)) {
      onOutput(`Archive imbriquée détectée (${basename(entry)})…`)
      await extractArchive(entry, dest, onOutput)
      if (findFile(dest, (n) => wanted.includes(n.toLowerCase()))) return
    }
  }
}

async function installGithub(tool: ToolDefinition, onOutput: (line: string) => void): Promise<void> {
  if (!tool.githubRepo) throw new Error('Référence GitHub manquante')
  const target = releaseTarget()
  const want = assetFilterFor(tool, target)
  if (!want) {
    throw new Error(
      tool.windowsOnly === true || isWindows() === false
        ? `${tool.name} n’est pas disponible sur ${platformLabel()} (asset absent).`
        : 'Référence GitHub manquante'
    )
  }
  const release = await fetch(`https://api.github.com/repos/${tool.githubRepo}/releases/latest`, {
    headers: { ...githubHeaders(), Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
  if (!release.ok) throw new Error(`Impossible de lire les releases GitHub (HTTP ${release.status})`)
  const body = (await release.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] }
  const assetUrl = selectReleaseAsset(tool.githubRepo, want, body.assets, target)
  assertGithubAssetUrl(assetUrl)

  // On nomme le fichier temporaire avec sa vraie extension : tar de GNU dispatche dessus.
  const assetName = new URL(assetUrl).pathname.split('/').pop() ?? `${tool.id}.zip`
  const archivePath = join(toolsDir(), `${tool.id}.download.${/\.zip$/i.test(assetName) ? 'zip' : 'tar.gz'}`)
  const workDir = join(toolsDir(), `${tool.id}.tmp`)
  activeInstalls.add(tool.id)
  try {
    onOutput(`Téléchargement de ${tool.id} (${target})…`)
    await downloadToFile(assetUrl, archivePath)
    await verifyArchive(tool, archivePath, assetName, body.assets ?? [], onOutput)
    onOutput('Extraction…')
    rmSync(workDir, { recursive: true, force: true })
    mkdirSync(workDir, { recursive: true })
    const wanted = exeCandidates(tool.id, tool.exeName).map((n) => n.toLowerCase())
    await extractUntilBinary(archivePath, workDir, wanted, onOutput)

    const found = findFile(workDir, (name) => wanted.includes(name.toLowerCase()))
    if (!found) throw new Error(`Binaire ${tool.exeName ?? tool.id} introuvable dans l’archive`)

    const destDir = join(toolsDir(), tool.id)
    rmSync(destDir, { recursive: true, force: true })
    mkdirSync(destDir, { recursive: true })
    const dest = join(destDir, portableBinaryName(tool.id, tool.exeName))
    copyFileSync(found, dest)
    makeExecutable(dest)
    onOutput(`Installé : ${basename(dest)}`)
  } finally {
    // Un échec d'extraction ou de vérification ne doit jamais laisser d'archive
    // à moitié écrite ni derépertoire temporaire derrière lui.
    rmSync(archivePath, { force: true })
    rmSync(workDir, { recursive: true, force: true })
    activeInstalls.delete(tool.id)
  }
}

export function findFile(dir: string, match: (name: string) => boolean): string | null {
  for (const entry of readdirRecursive(dir)) {
    if (match(basename(entry))) return entry
  }
  return null
}

function readdirRecursive(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(dir)
  return out
}

/**
 * Installe un outil Go via `go install <module>@latest` avec GOBIN dirigé vers
 * tools/<id> : le binaire atterrit exactement là où resolveBinary et
 * hasPortableBinary le cherchent pour une source portable, sans toucher au
 * GOPATH global. Rien n'est exécuté en dehors de la toolchain Go elle-même.
 */
async function installGo(tool: ToolDefinition, onOutput: (line: string) => void): Promise<void> {
  const pkg = tool.goPackage
  if (!pkg) throw new Error(`goPackage absent du catalogue pour ${tool.id}`)

  let probe = -1
  try {
    probe = await run('go', ['version'], undefined, DETECT_TIMEOUT_MS)
  } catch {
    probe = -1
  }
  if (probe !== 0) {
    throw new Error(
      'Go introuvable sur cette machine : installez l’outil Go du catalogue (source winget), puis relancez.'
    )
  }

  const binDir = join(toolsDir(), tool.id)
  mkdirSync(binDir, { recursive: true })
  onOutput(`go install ${pkg}…`)
  const code = await withSystemInstallLock(() =>
    run('go', ['install', pkg], onOutput, RUN_TIMEOUT_MS, { GOBIN: binDir })
  )
  if (code === TIMEOUT_CODE) throw new Error('go install : délai dépassé (5 min)')
  if (code !== 0) throw new Error(`go install a échoué (code ${code})`)

  const binary = join(binDir, portableBinaryName(tool.id, tool.exeName))
  if (!existsSync(binary)) {
    const found = readdirSync(binDir).join(', ') || '(aucun fichier)'
    throw new Error(
      `Binaire ${portableBinaryName(tool.id, tool.exeName)} introuvable après go install.`
      + ` Fichiers produits : ${found}.`
      + ' Renseignez exeName dans le catalogue si le binaire porte un autre nom.'
    )
  }
  onOutput(`Installé : ${basename(binary)}`)
}

async function installGit(tool: ToolDefinition, onOutput: (line: string) => void): Promise<void> {
  if (!tool.githubRepo) throw new Error('Référence GitHub manquante')
  const dest = gitPkgPath(tool.id)

  if (await isGitRepoCloned(dest)) {
    writeFileSync(join(dest, MARKER), JSON.stringify({ installedAt: new Date().toISOString(), repo: tool.githubRepo }, null, 2))
    onOutput(`Clone déjà présent dans ${dest}, rien à re-cloner.`)
    onOutput('Aucun script exécuté automatiquement : suivez le guide du framework avant usage.')
    return
  }

  await rmRetry(dest)
  mkdirSync(dest, { recursive: true })
  onOutput(`Clonage de https://github.com/${tool.githubRepo}…`)
  const code = await run('git', ['clone', '--depth', '1', `https://github.com/${tool.githubRepo}.git`, dest], onOutput)
  if (code !== 0) {
    await rmRetry(dest)
    throw new Error('Clonage échoué (git)')
  }
  writeFileSync(join(dest, MARKER), JSON.stringify({ installedAt: new Date().toISOString(), repo: tool.githubRepo }, null, 2))
  onOutput(`Cloné dans ${dest}`)
  onOutput('Aucun script exécuté automatiquement : suivez le guide du framework avant usage.')
}

/**
 * apt exige les privilèges root. On tente pkexec (polkit, invite graphique
 * standard sur les desktops Linux) ; en son absence on renvoie un message
 * actionnable au lieu d'un échec opaque. Retourne null si l'installation a réussi.
 */
async function installViaApt(tool: ToolDefinition, onOutput: (line: string) => void): Promise<string | null> {
  const pkg = tool.aptPackage!
  const args = ['apt-get', 'install', '-y', '--no-install-recommends', pkg]
  onOutput(`Installation de ${pkg} via apt (privilèges administrateur requis)…`)
  const code = await run('pkexec', args, onOutput).catch(() => -1)
  if (code === 0) return null
  const sudoCode = await run('sudo', ['-n', ...args], onOutput).catch(() => -1)
  if (sudoCode === 0) return null
  if (code === -1 && sudoCode === -1) {
    return `Installation impossible : ni pkexec ni sudo disponibles pour ${pkg}.`
  }
  return `apt a échoué (pkexec ${code}, sudo ${sudoCode}) pour ${pkg}.`
}

/**
 * Installe une distribution PyPI dans un venv isolé sous tools/<id>. Rien n'est
 * ajouté à l'interpréteur système : le script console créé par pip devient le
 * binaire trouvé par resolveBinary. uv sert d'outil (déjà présent au catalogue).
 */
async function installPip(tool: ToolDefinition, onOutput: (line: string) => void): Promise<void> {
  const dist = tool.pipPackage ?? tool.id
  const dir = join(toolsDir(), tool.id)
  const venv = join(dir, '.venv')
  const uv = resolveBinary('uv') ?? 'uv'
  mkdirSync(dir, { recursive: true })
  // On repart d'un venv neuf : un venv partiel rend un script console incomplet.
  rmSync(venv, { recursive: true, force: true })

  onOutput(`Création d'un venv pour ${dist}…`)
  const venvCode = await run(uv, ['venv', venv], onOutput)
  if (venvCode !== 0) {
    throw new Error(
      `uv venv a échoué (code ${venvCode}). Installez uv (outil du catalogue) avant de réessayer.`
    )
  }

  const py = isWindows() ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
  onOutput(`Installation de ${dist} depuis PyPI…`)
  const installCode = await run(uv, ['pip', 'install', '--python', py, dist], onOutput)
  if (installCode !== 0) throw new Error(`Installation de ${dist} a échoué (code ${installCode})`)

  const script = pipScriptPath(tool)
  if (!existsSync(script)) {
    // Sans cette liste, un nom d'entrée point faux se traduit par un échec
    // muet : on montre plutôt ce que pip a réellement créé pour que l'ajout
    // d'une entrée au catalogue soit vérifiable à la main.
    const binDir = isWindows() ? join(venv, 'Scripts') : join(venv, 'bin')
    const noise = /^(python|pip|activate|Activate|Activate\.)/
    const found = existsSync(binDir)
      ? readdirSync(binDir).filter((n) => !noise.test(n)).join(', ')
      : '(dossier absent)'
    throw new Error(
      `Entrée point « ${tool.exeName ?? tool.id} » introuvable après installation de ${dist}.`
      + ` Scripts disponibles : ${found || '(aucun)'}.`
      + ' Renseignez exeName dans le catalogue avec le bon nom.'
    )
  }
  if (!isWindows()) makeExecutable(script)
  onOutput(`Installé : ${basename(script)}`)
}

/** Une installation par outil : l'UI, le pont MCP et les tests peuvent frapper en même temps. */
const installsInFlight = new Map<string, Promise<ToolInstallationResult>>()

export async function installTool(id: string, onOutput?: (line: string) => void): Promise<ToolInstallationResult> {
  // Deux installations simultanées du meme outil s'arrachent le meme dossier :
  // on refuse la deuxieme plutot que de corrompre la premiere.
  if (installsInFlight.has(id)) {
    return { ok: false, error: `Une installation de « ${id} » est déjà en cours.` }
  }
  const task = runInstallTool(id, onOutput).finally(() => {
    installsInFlight.delete(id)
  })
  installsInFlight.set(id, task)
  return task
}

async function runInstallTool(id: string, onOutput?: (line: string) => void): Promise<ToolInstallationResult> {
  const tool = getTool(id)
  if (!tool) return { ok: false, error: `Outil inconnu : ${id}` }
  try {
    if (await isInstalled(tool)) {
      onOutput?.('Déjà installé, rien à faire.')
      return { ok: true, installed: true }
    }
    if (tool.source === 'pip') {
      await installPip(tool, onOutput ?? (() => {}))
      return { ok: true, installed: await isInstalled(tool) }
    }
    if (tool.source === 'go') {
      await installGo(tool, onOutput ?? (() => {}))
      return { ok: true, installed: await isInstalled(tool) }
    }
    if (tool.source === 'winget' && tool.wingetId) {
      if (tool.windowsOnly === true && !isWindows()) {
        return { ok: false, error: `${tool.name} est un outil Windows uniquement.` }
      }
      if (tool.guiOnly === true) {
        return {
          ok: false,
          error: `${tool.name} est une application graphique : installez-la depuis son site ou votre store Linux.`
        }
      }
      if (isWindows()) {
        const args = [
          'install',
          '--exact',
          '--id',
          tool.wingetId,
          '--silent',
          '--accept-source-agreements',
          '--accept-package-agreements',
          '--disable-interactivity'
        ]
        const code = await withSystemInstallLock(() => run('winget', args, onOutput))
        if (code === TIMEOUT_CODE) return { ok: false, error: 'winget : délai dépassé (5 min).' }
        if (code !== 0) return { ok: false, error: `winget a échoué (code ${code})` }
      } else if (tool.aptPackage) {
        const aptError = await withSystemInstallLock(() =>
          installViaApt(tool, onOutput ?? (() => {}))
        )
        if (aptError !== null) return { ok: false, error: aptError }
      } else {
        return {
          ok: false,
          error: `${tool.name} n’a pas de paquet Linux non-root. Installez-le avec votre gestionnaire de paquets, puis relancez.`
        }
      }
    } else if (tool.source === 'git') {
      await installGit(tool, onOutput ?? (() => {}))
    } else {
      // Decision prise AVANT toute tentative de téléchargement : si GitHub n'a
      // pas d'asset pour cette plateforme, on sait deja qu'installGithub va
      // echouer, alors on appelle apt explicitement. Ce n'est jamais un repli en
      // catch : un binaire corrompu ou un echec de verification d'integrite ne
      // doit pas pouvoir etre contourne par une installation via apt.
      const wanted = assetFilterFor(tool, releaseTarget())
      // assetFilterFor retourne undefined (jamais null) quand aucun filtre
      // d'asset n'est configuré : sans ce comparateur, le repli apt ci-dessous
      // était du code mort et installGithub échouait sur un asset absent.
      if (!isWindows() && tool.aptPackage && wanted === undefined) {
        const aptError = await withSystemInstallLock(() => installViaApt(tool, onOutput ?? (() => {})))
        if (aptError !== null) return { ok: false, error: aptError }
      } else {
        await installGithub(tool, onOutput ?? (() => {}))
      }
    }
    // L'installation vient de changer l'état : on repart d'une enumeration
    // fraiche (le cache d'enumeration winget vit 60 s) avant la verification
    // finale, qui sert de preuve d'installation a l'UI.
    resetWingetDetection()
    return { ok: true, installed: await isInstalled(tool) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}