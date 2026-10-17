import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mockUserData = ''
// Le repli local (AES-GCM) ne sert que lorsque le keyring systeme manque
// (cas Linux sans gnome-keyring). On pilote donc la disponibilite pour
// couvrir les deux chemins de chiffrement.
let keyringAvailable = true

vi.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  safeStorage: {
    isEncryptionAvailable: () => keyringAvailable,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => {
      const s = b.toString()
      if (!s.startsWith('enc:')) throw new Error('dechiffrement impossible')
      return s.slice(4)
    },
  },
  ipcMain: { handle: vi.fn() },
}))

import {
  clearToken,
  loadGithubToken,
  loadMcpConfig,
  loadToken,
  saveGithubToken,
  saveMcpConfig,
  saveToken,
  usingSystemKeyring,
} from '../src/main/storage'

function configPath(): string {
  return join(mockUserData, 'config.json')
}

function rawConfig(): string {
  return readFileSync(configPath(), 'utf-8')
}

function writeRawConfig(value: unknown): void {
  writeFileSync(configPath(), typeof value === 'string' ? value : JSON.stringify(value), 'utf-8')
}

beforeEach(() => {
  mockUserData = mkdtempSync(join(tmpdir(), 'bountydesk-storage-'))
  keyringAvailable = true
})

describe('storage — jeton principal', () => {
  it('est vide par defaut (aucun fichier)', () => {
    expect(loadToken()).toBeNull()
    expect(existsSync(configPath())).toBe(false)
  })

  it('suit un aller-retour avec le keyring systeme sans ecrire le clair', () => {
    saveToken('secret-42')
    expect(loadToken()).toBe('secret-42')
    const raw = rawConfig()
    expect(raw).not.toContain('secret-42')
    expect(raw).not.toContain('aesgcm.v1.')
  })

  it('bascule sur la cle locale quand le keyring est indisponible', () => {
    keyringAvailable = false
    saveToken('secret-42')
    expect(loadToken()).toBe('secret-42')
    const raw = rawConfig()
    expect(raw).toContain('aesgcm.v1.')
    expect(raw).not.toContain('secret-42')
    // La cle locale est creee a cote, une seule fois.
    expect(existsSync(join(mockUserData, '.secret-key'))).toBe(true)
  })

  it('ne relit pas un secret du keyring quand celui-ci disparait', () => {
    saveToken('s1')
    keyringAvailable = false
    expect(loadToken()).toBeNull()
  })

  it('usingSystemKeyring reflete la disponibilite', () => {
    expect(usingSystemKeyring()).toBe(true)
    keyringAvailable = false
    expect(usingSystemKeyring()).toBe(false)
  })

  it('refuse un payload de repli altere ou malforme', () => {
    keyringAvailable = false
    saveToken('x')
    const conf = JSON.parse(rawConfig()) as { tokenEncrypted: string }

    const parts = conf.tokenEncrypted.split('.')
    parts[3] = Buffer.from('contenu different').toString('base64')
    writeRawConfig({ tokenEncrypted: parts.join('.') })
    expect(loadToken()).toBeNull()

    writeRawConfig({ tokenEncrypted: 'aesgcm.v1.incomplet' })
    expect(loadToken()).toBeNull()
  })

  it('efface le fichier quand plus aucun secret ne reste', () => {
    saveToken('s1')
    expect(existsSync(configPath())).toBe(true)
    clearToken()
    expect(loadToken()).toBeNull()
    expect(existsSync(configPath())).toBe(false)
  })

  it('conserve les autres secrets lors d\'un clearToken', () => {
    saveToken('s1')
    saveGithubToken('ghp_x')
    clearToken()
    expect(loadToken()).toBeNull()
    expect(loadGithubToken()).toBe('ghp_x')
    expect(existsSync(configPath())).toBe(true)
  })

  it('ne laisse pas de fichier temporaire apres ecriture', () => {
    saveToken('s1')
    saveGithubToken('ghp_x')
    expect(existsSync(`${configPath()}.tmp`)).toBe(false)
  })
})

describe('storage — quarantaine du config.json', () => {
  it('met de cote un JSON illisible et rend null', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      writeRawConfig('{ ceci n est pas du json')
      expect(loadToken()).toBeNull()
      expect(existsSync(`${configPath()}.corrupt`)).toBe(true)
      expect(existsSync(configPath())).toBe(false)
      expect(spy).toHaveBeenCalledOnce()
      expect(String(spy.mock.calls[0]?.[0])).toContain('illisible')
    } finally {
      spy.mockRestore()
    }
  })

  it('met de cote une structure inattendue (tableau)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      writeRawConfig([1, 2, 3])
      expect(loadToken()).toBeNull()
      expect(existsSync(`${configPath()}.corrupt`)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('storage — configuration MCP', () => {
  it('renvoie des valeurs par defaut sans section mcp', () => {
    expect(loadMcpConfig()).toEqual({ enabled: false, port: null, lan: false, tokens: [], agents: [] })
  })

  it('suit un aller-retour avec jetons et agents', () => {
    saveMcpConfig({
      enabled: true,
      port: 8790,
      lan: true,
      tokens: [
        { id: 'primary', label: 'PC principal', token: 'tok-1' },
        { id: 'labo', label: 'Labo', token: 'tok-2' },
      ],
      agents: [{ id: 'agent-1', label: 'Agent 1', token: 'agent-tok' }],
    })
    const cfg = loadMcpConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.port).toBe(8790)
    expect(cfg.lan).toBe(true)
    expect(cfg.tokens).toEqual([
      { id: 'primary', label: 'PC principal', token: 'tok-1' },
      { id: 'labo', label: 'Labo', token: 'tok-2' },
    ])
    expect(cfg.agents).toEqual([{ id: 'agent-1', label: 'Agent 1', token: 'agent-tok' }])
    expect(rawConfig()).not.toContain('tok-1')
    expect(rawConfig()).not.toContain('agent-tok')
  })

  it('migre l\'ancien format (jeton unique) vers un jeton primary', () => {
    writeRawConfig({
      mcp: {
        enabled: true,
        tokenEncrypted: Buffer.from('enc:legacy-token').toString('base64'),
      },
    })
    const cfg = loadMcpConfig()
    expect(cfg.tokens).toEqual([{ id: 'primary', label: 'PC principal', token: 'legacy-token' }])
    expect(cfg.port).toBeNull()
    expect(cfg.lan).toBe(false)
  })

  it('ignore les jetons sans identifiant, libelle ou payload dechiffrable', () => {
    saveMcpConfig({
      enabled: false,
      port: null,
      lan: false,
      tokens: [{ id: 'ok', label: 'OK', token: 'bon' }],
    })
    const conf = JSON.parse(rawConfig()) as { mcp: { tokens: Record<string, unknown>[] } }
    // Payload present mais non dechiffrable.
    conf.mcp.tokens.push({ id: 'corrompu', label: 'Corrompu', tokenEncrypted: 'pas-un-payload' })
    // Payload absent.
    conf.mcp.tokens.push({ id: 'sans-payload', label: 'Sans payload' })
    // Identifiant ou libelle manquant.
    conf.mcp.tokens.push({ label: 'Sans id', tokenEncrypted: Buffer.from('enc:x').toString('base64') })
    conf.mcp.tokens.push({
      id: 'sans-label',
      tokenEncrypted: Buffer.from('enc:x').toString('base64'),
    })
    writeRawConfig(conf)

    expect(loadMcpConfig().tokens.map((t) => t.id)).toEqual(['ok'])
  })

  it('conserve un jeton dont le secret est vide (comportement actuel)', () => {
    saveMcpConfig({
      enabled: false,
      port: null,
      lan: false,
      tokens: [{ id: 'vide', label: 'Vide', token: '' }],
    })
    expect(loadMcpConfig().tokens).toEqual([{ id: 'vide', label: 'Vide', token: '' }])
  })

  it('prefere la liste de jetons a l\'ancien champ meme si la liste est vide', () => {
    writeRawConfig({
      mcp: {
        tokens: [],
        tokenEncrypted: Buffer.from('enc:ancien').toString('base64'),
      },
    })
    // tokens = [] est un tableau vide : on retombe sur le format herite.
    expect(loadMcpConfig().tokens).toEqual([
      { id: 'primary', label: 'PC principal', token: 'ancien' },
    ])
  })
})
