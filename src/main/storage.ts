import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import { dirname, join } from 'path'

/**
 * Sous Linux, safeStorage exige un keyring (gnome-keyring / kwallet / libsecret).
 * Sans keyring, isEncryptionAvailable() vaut false et l'app devient inutilisable :
 * impossible de se connecter ni d'activer le serveur MCP. On dérive alors une clé
 * locale (fichier 0600 dans userData) pour chiffrer en AES-256-GCM. C'est moins
 * fort qu'un keyring système (la clé est sur le même disque que le secret), mais
 * c'est strictement mieux que de refuser de fonctionner.
 * Remarque : privilégier un keyring système quand disponible.
 */
const FALLBACK_PREFIX = 'aesgcm.v1.'
const FALLBACK_SALT = 'bountydesk-secret-v1'
const FALLBACK_KEY_BYTES = 32
const FALLBACK_IV_BYTES = 12

interface McpTokenStored {
  id: string
  label: string
  tokenEncrypted?: string
}

interface McpStored {
  enabled?: boolean
  port?: number
  lan?: boolean
  tokenEncrypted?: string
  tokens?: McpTokenStored[]
  agents?: McpTokenStored[]
}

interface StoredConfig {
  tokenEncrypted?: string
  githubTokenEncrypted?: string
  mcp?: McpStored
}

function configFile(): string {
  return join(app.getPath('userData'), 'config.json')
}

/**
 * config.json contient tous les secrets de l'app : une lecture ratée ne doit
 * jamais le faire disparaître silencieusement au prochain enregistrement.
 * Le fichier illisible est mis de côté (.corrupt) et l'évènement est journalisé.
 */
function quarantineCorruptConfig(file: string, reason: string): void {
  console.error(`Venari : config.json illisible (${reason}) — fichier conservé en ${file}.corrupt`)
  try {
    renameSync(file, `${file}.corrupt`)
  } catch {
    /* le fichier a pu être supprimé entre-temps : rien de plus à faire */
  }
}

function readConfig(): StoredConfig {
  const file = configFile()
  if (!existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
  } catch (err) {
    quarantineCorruptConfig(file, err instanceof Error ? err.message : String(err))
    return {}
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as StoredConfig
  quarantineCorruptConfig(file, 'structure inattendue')
  return {}
}

function writeConfig(config: StoredConfig): void {
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true })
  // Écriture atomique : un plantage au milieu d'un writeFileSync tronquerait
  // config.json et ferait perdre tous les jetons d'un coup.
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(config), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, file)
}

function fallbackKeyFile(): string {
  return join(app.getPath('userData'), '.secret-key')
}

function fallbackKey(): Buffer {
  const file = fallbackKeyFile()
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(FALLBACK_KEY_BYTES).toString('base64'), {
      encoding: 'utf-8',
      mode: 0o600
    })
  }
  return scryptSync(readFileSync(file, 'utf-8'), FALLBACK_SALT, FALLBACK_KEY_BYTES)
}

function encryptFallback(text: string): string {
  const iv = randomBytes(FALLBACK_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', fallbackKey(), iv)
  const enc = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()])
  return `${FALLBACK_PREFIX}${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`
}

function decryptFallback(payload: string): string | null {
  const body = payload.slice(FALLBACK_PREFIX.length)
  const parts = body.split('.')
  if (parts.length !== 3) return null
  const [ivB64, tagB64, dataB64] = parts
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      fallbackKey(),
      Buffer.from(ivB64!, 'base64')
    )
    decipher.setAuthTag(Buffer.from(tagB64!, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64!, 'base64')), decipher.final()]).toString('utf-8')
  } catch {
    return null
  }
}

/**
 * Chiffrement des secrets hors config (credentials de mission, …) :
 * trousseau système quand il est là, repli AES-GCM local sinon.
 * Le préfixe `aesgcm.v1.` identifie le repli ; tout le reste est du safeStorage.
 */
export function encryptSecret(text: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(text).toString('base64')
  }
  return encryptFallback(text)
}

/** @returns null quand le secret est illisible (clé perdue, safeStorage absent). */
export function decryptSecret(payload: string): string | null {
  if (payload.startsWith(FALLBACK_PREFIX)) return decryptFallback(payload)
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(payload, 'base64'))
  } catch {
    return null
  }
}

/** true si les secrets sont protégés par le keyring du système (pas par la clé locale). */
export function usingSystemKeyring(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function loadToken(): string | null {
  const config = readConfig()
  if (typeof config.tokenEncrypted !== 'string' || config.tokenEncrypted.length === 0) {
    return null
  }
  return decryptSecret(config.tokenEncrypted)
}

export function saveToken(token: string): void {
  const config = readConfig()
  config.tokenEncrypted = encryptSecret(token)
  writeConfig(config)
}

export function clearToken(): void {
  const config = readConfig()
  delete config.tokenEncrypted
  if (config.mcp === undefined && config.githubTokenEncrypted === undefined) {
    rmSync(configFile(), { force: true })
  } else {
    writeConfig(config)
  }
}

export function loadGithubToken(): string | null {
  const config = readConfig()
  if (typeof config.githubTokenEncrypted !== 'string' || config.githubTokenEncrypted.length === 0) {
    return null
  }
  return decryptSecret(config.githubTokenEncrypted)
}

export function saveGithubToken(token: string): void {
  const config = readConfig()
  config.githubTokenEncrypted = encryptSecret(token)
  writeConfig(config)
}

export function clearGithubToken(): void {
  const config = readConfig()
  delete config.githubTokenEncrypted
  if (config.mcp === undefined && config.tokenEncrypted === undefined) {
    rmSync(configFile(), { force: true })
  } else {
    writeConfig(config)
  }
}

export interface McpToken {
  id: string
  label: string
  token: string
}

export interface McpConfig {
  enabled: boolean
  port: number | null
  lan: boolean
  tokens: McpToken[]
  agents: McpToken[]
}

const PRIMARY_ID = 'primary'

function storedTokens(list: McpTokenStored[] | undefined, legacy: string | undefined): McpToken[] {
  // Format hérité : un seul token chiffré → on le migre en token 'primary'
  if (Array.isArray(list) && list.length > 0) {
    return list.flatMap((t) => {
      if (typeof t.id !== 'string' || typeof t.label !== 'string') return []
      if (typeof t.tokenEncrypted !== 'string' || t.tokenEncrypted.length === 0) return []
      const token = decryptSecret(t.tokenEncrypted)
      return token !== null ? [{ id: t.id, label: t.label, token }] : []
    })
  }
  if (typeof legacy === 'string' && legacy.length > 0) {
    const token = decryptSecret(legacy)
    return token !== null ? [{ id: PRIMARY_ID, label: 'PC principal', token }] : []
  }
  return []
}

export function loadMcpConfig(): McpConfig {
  const config = readConfig()
  const mcp = config.mcp
  if (!mcp || typeof mcp !== 'object') {
    return { enabled: false, port: null, lan: false, tokens: [], agents: [] }
  }
  return {
    enabled: mcp.enabled === true,
    port: typeof mcp.port === 'number' ? mcp.port : null,
    lan: mcp.lan === true,
    tokens: storedTokens(mcp.tokens, mcp.tokenEncrypted),
    agents: storedTokens(mcp.agents, undefined),
  }
}

export function saveMcpConfig(cfg: { enabled: boolean; port: number | null; lan: boolean; tokens: McpToken[]; agents?: McpToken[] }): void {
  const config = readConfig()
  config.mcp = {
    enabled: cfg.enabled,
    port: cfg.port ?? undefined,
    lan: cfg.lan,
    tokens: cfg.tokens.map((t) => ({ id: t.id, label: t.label, tokenEncrypted: encryptSecret(t.token) })),
    agents: (cfg.agents ?? []).map((t) => ({ id: t.id, label: t.label, tokenEncrypted: encryptSecret(t.token) })),
  }
  writeConfig(config)
}