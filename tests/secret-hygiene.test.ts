import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'bountydesk-secret-test-'))
const clipboardWrites: string[] = []

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  clipboard: {
    writeText: (text: string) => {
      clipboardWrites.push(text)
    },
  },
  shell: { openExternal: async () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
  ipcMain: { handle: vi.fn() },
  Notification: class {},
}))

vi.mock('../src/main/services/tools/installer', () => ({
  currentTools: async () => [],
  installTool: async (_id: string) => ({ ok: true as const, installed: true }),
  resolveBinary: () => null,
  resolveWordlist: () => null,
  toolsDir: () => userData,
}))

import { closeDb, getRepository } from '../src/main/db'
import { registerMcpIpc } from '../src/main/ipc-mcp'
import { registerDetailIpc } from '../src/main/ipc-detail'
import { loadMcpConfig } from '../src/main/storage'
import type { ProgramInput } from '../src/main/db/repo'
import { IPC } from '../src/shared/ipc'
import { ipcMain } from 'electron'

const handlers: Record<string, (event: unknown, arg?: unknown) => Promise<unknown> | unknown> = {}

beforeAll(() => {
  registerMcpIpc()
  registerDetailIpc()
  for (const [channel, handler] of vi.mocked(ipcMain.handle).mock.calls) {
    handlers[channel as string] = handler as (event: unknown, arg?: unknown) => Promise<unknown>
  }
})

function call(channel: string, arg?: unknown): Promise<unknown> {
  const handler = handlers[channel]
  if (!handler) throw new Error(`handler ${channel} absent`)
  return Promise.resolve(handler({ sender: { id: 1 } }, arg))
}

const SECRET = 'motdepasse-tres-secret-42'

/**
 * Ces tests sont la frontiere de securite elle-meme : un secret configure doit
 * etre absent de toute charge utile IPC destinee au renderer. Ils casseraient si
 * quelqu'un re-ajoute `token` ou `secret` dans une reponse.
 */
describe('les secrets ne sortent pas du processus principal', () => {
  let mcpToken = ''
  let mcpTokenId = ''
  let agentToken = ''
  let agentTokenId = ''
  let credentialId = 0

  beforeEach(async () => {
    closeDb()
    rmSync(join(userData, 'bountydesk.db'), { force: true })
    rmSync(join(userData, 'bountydesk.db-wal'), { force: true })
    rmSync(join(userData, 'bountydesk.db-shm'), { force: true })
    rmSync(join(userData, 'config.json'), { force: true })
    getRepository().upsertPrograms([
      {
        id: 'prog-1', handle: 'acme', name: 'Acme', type: 'bug_bounty', status: 'active',
        confidentiality: 'public', minBounty: null, maxBounty: null, industry: null,
        webLink: null, following: false, rawJson: null,
      } as ProgramInput,
    ])
    clipboardWrites.length = 0

    // Un jeton MCP, un jeton d'agent et un identifiant, crees par les canaux eux-memes.
    const added = (await call(IPC.McpTokenAdd, { label: 'PC bureau' })) as { ok: boolean; id: string; masked: string }
    expect(added.ok).toBe(true)
    mcpTokenId = added.id
    expect(added.masked.startsWith('•')).toBe(true)

    const agent = (await call(IPC.AgentTokenAdd, { label: 'Boite' })) as { ok: boolean; id: string; masked: string }
    expect(agent.ok).toBe(true)
    agentTokenId = agent.id

    const cred = (await call(IPC.CredentialsAdd, {
      programId: 'prog-1',
      label: 'Compte admin',
      username: 'admin',
      secret: SECRET,
      note: '',
    })) as { ok: boolean; id: number }
    expect(cred.ok).toBe(true)
    credentialId = cred.id

    // Les jetons sont chiffres sur disque : on les relit via le service du main,
    // ce que le renderer n'a pas le droit de faire.
    const cfg = loadMcpConfig()
    mcpToken = cfg.tokens.find((t) => t.id === mcpTokenId)!.token
    agentToken = (cfg.agents ?? []).find((t) => t.id === agentTokenId)!.token
    expect(mcpToken.length).toBeGreaterThan(20)
  })

  it('mcp:status ne renvoie aucun jeton en clair', async () => {
    const status = await call(IPC.McpStatus)
    expect(JSON.stringify(status)).not.toContain(mcpToken)
    const tokens = (status as { tokens: { masked: string }[] }).tokens
    expect(tokens.every((t) => t.masked.startsWith('••••••••'))).toBe(true)
  })

  it('agent:tokens ne renvoie aucun jeton en clair', async () => {
    const res = await call(IPC.AgentTokens)
    expect(JSON.stringify(res)).not.toContain(agentToken)
  })

  it('credentials:list ne renvoie aucun secret en clair', async () => {
    const res = (await call(IPC.CredentialsList, 'prog-1')) as {
      ok: boolean
      credentials: { hasSecret: boolean; secret?: string }[]
    }
    expect(res.ok).toBe(true)
    expect(JSON.stringify(res)).not.toContain(SECRET)
    expect(res.credentials[0]!.hasSecret).toBe(true)
    expect(res.credentials[0]!.secret).toBeUndefined()
  })

  it('credentials:reveal ne dechiffre que la ligne demandee', async () => {
    const res = (await call(IPC.CredentialsReveal, credentialId)) as { ok: boolean; secret: string }
    expect(res.ok).toBe(true)
    expect(res.secret).toBe(SECRET)
  })

  it('agent:sessions n’expose pas le jeton bearer de l’agent', async () => {
    const res = (await call(IPC.AgentSessions)) as { ok: boolean; sessions: unknown[] }
    expect(JSON.stringify(res)).not.toContain(agentToken)
    expect(JSON.stringify(res)).not.toContain('agentToken')
  })

  it('secret:copy ecrit le vrai jeton dans le presse-papier du main', async () => {
    const res = (await call(IPC.SecretCopy, { kind: 'mcpToken', id: mcpTokenId })) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(clipboardWrites.at(-1)).toBe(mcpToken)

    const agentRes = (await call(IPC.SecretCopy, { kind: 'agentToken', id: agentTokenId })) as { ok: boolean }
    expect(agentRes.ok).toBe(true)
    expect(clipboardWrites.at(-1)).toBe(agentToken)
  })

  it('secret:copy refuse un identifiant inconnu au lieu de copier autre chose', async () => {
    const res = (await call(IPC.SecretCopy, { kind: 'mcpToken', id: 'inexistant' })) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(clipboardWrites).toHaveLength(0)
  })

  it('secret:copy de la config produit un JSON valide porteur du jeton', async () => {
    await call(IPC.McpSetEnabled, { enabled: true, lan: false })
    const res = (await call(IPC.SecretCopy, { kind: 'mcpConfig' })) as { ok: boolean }
    expect(res.ok).toBe(true)
    const written = clipboardWrites.at(-1)!
    expect(JSON.parse(written)).toMatchObject({
      bountydesk: { type: 'remote', headers: { Authorization: `Bearer ${mcpToken}` } },
    })
  })
})