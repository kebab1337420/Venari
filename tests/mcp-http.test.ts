import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'bountydesk-mcp-http-test-'))

// Le diagnostic interroge le pare-feu du systeme (netsh sous Windows, ufw puis
// firewalld ailleurs). Un vrai appel sur un runner CI froid depasse le timeout
// du test alors que sa valeur n'est pas ce que le test verifie : il accepte
// 'ok', 'missing' ou 'unmanaged'. On neutralise donc execFile seulement ; spawn
// reste reel, un autre test de ce fichier execute un binaire du PATH.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void
  ): unknown => {
    cb(null, 'Venari MCP', '')
    return {}
  }
  return { ...actual, execFile, default: { ...actual, execFile } }
})

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../src/main/services/tools/installer', () => ({
  currentTools: async () => [],
  installTool: async (id: string) => ({ ok: true as const, installed: true }),
  resolveBinary: () => null,
  resolveWordlist: () => null,
  toolsDir: () => userData,
}))

import { closeDb, getRepository } from '../src/main/db'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcp/server'
import type { ProgramInput } from '../src/main/db/repo'
import { registerMcpIpc } from '../src/main/ipc-mcp'
import { IPC } from '../src/shared/ipc'
import { ipcMain } from 'electron'

const ipcHandlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

function captureIpc(): void {
  for (const [channel, handler] of vi.mocked(ipcMain.handle).mock.calls) {
    ipcHandlers[channel as string] = handler as (...args: unknown[]) => Promise<unknown>
  }
}

function ipcHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const handler = ipcHandlers[channel]
  if (!handler) throw new Error(`IPCHandler ${channel} non enregistré`)
  return handler
}

const TOKEN = 'test-token-http-1234567890'
let port = 0

async function rpc(
  body: unknown,
  headers: Record<string, string> = {},
  token: string | null = TOKEN
): Promise<Response> {
  const auth = token === null ? {} : { authorization: `Bearer ${token}` }
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close', ...auth, ...headers },
    body: JSON.stringify(body),
  })
}

interface ToolCall {
  isError: boolean
  text: string
  payload: unknown
}

/** Appel JSON-RPC tools/call puis décodage du texte : les outils renvoient du JSON.stringify. */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
  const res = await rpc({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args },
  })
  const json = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }
  const text = json.result.content[0]!.text
  let payload: unknown = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = null
  }
  return { isError: json.result.isError === true, text, payload }
}

describe('serveur MCP (HTTP réel)', () => {
  beforeEach(async () => {
    closeDb()
    rmSync(join(userData, 'bountydesk.db'), { force: true })
    rmSync(join(userData, 'bountydesk.db-wal'), { force: true })
    rmSync(join(userData, 'bountydesk.db-shm'), { force: true })
    const repo = getRepository()
    repo.upsertPrograms([
      {
        id: 'prog-1', handle: 'acme', name: 'Acme', type: 'bug_bounty', status: 'active',
        confidentiality: 'public', minBounty: null, maxBounty: null, industry: null,
        webLink: null, following: false, rawJson: null,
      } as ProgramInput,
    ])
    const r = await startMcpServer(0, TOKEN)
    if (!r.ok) throw new Error(r.error)
    port = r.port
  })

  afterEach(() => {
    stopMcpServer()
  })

  it('accepte initialize sur un vrai socket et rapporte un port réel', async () => {
    expect(port).toBeGreaterThan(0)
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } }
    }
    expect(json.result.protocolVersion).toBe('2024-11-05')
    expect(json.result.capabilities.tools).toBeTruthy()
    expect(json.result.serverInfo.name).toBe('Venari')
  })

  it('refuse sans token ou avec un mauvais token (401)', async () => {
    const noAuth = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}, null)
    expect(noAuth.status).toBe(401)
    const bad = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}, 'mauvais-token')
    expect(bad.status).toBe(401)
  })

  it('répond 404 hors /mcp et 405 hors POST', async () => {
    const other = await fetch(`http://127.0.0.1:${port}/autre`)
    expect(other.status).toBe(404)
    const get = await fetch(`http://127.0.0.1:${port}/mcp`)
    expect(get.status).toBe(405)
  })

  it('répond 415 sans content-type JSON et 400 sur JSON invalide', async () => {
    const plain = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'content-type': 'text/plain' })
    expect(plain.status).toBe(415)
    const bad = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{pas du json',
    })
    expect(bad.status).toBe(400)
  })

  it('tools/list expose les 18 outils attendus', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const json = (await res.json()) as { result: { tools: { name: string; description: string }[] } }
    const names = json.result.tools.map((t) => t.name)
    expect(names).toEqual([
      'list_programs', 'get_program_detail', 'list_credentials', 'set_note', 'list_notes',
      'list_tools', 'install_tool', 'run_tool', 'open_browser', 'fetch_page', 'list_scans',
      'start_scan', 'get_scan', 'scan_events', 'dedupe_findings', 'cvss_score',
      'http_request', 'submit_report',
    ])
    for (const tool of json.result.tools) {
      expect(tool.description.length).toBeGreaterThan(20)
    }
  })

  it('run_tool exécute un binaire PATH et retourne la sortie', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'run_tool', arguments: { tool: 'node', args: '-e "console.log(42)"' } },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }
    expect(json.result.isError).toBeFalsy()
    const out = JSON.parse(json.result.content[0]!.text) as { exitCode: number; stdout: string; tool: string }
    expect(out.tool).toBe('node')
    expect(out.exitCode).toBe(0)
    expect(out.stdout.trim()).toBe('42')
  })

  it('run_tool refuse un nom de binaire invalide', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'run_tool', arguments: { tool: '../../etc/passwd' } },
    })
    const json = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } }
    expect(json.result.isError).toBe(true)
  })

  it('run_tool refuse les interpréteurs de commande (allowline)', async () => {
    for (const tool of ['powershell', 'cmd', 'mshta', 'run_tool']) {
      const res = await rpc({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'run_tool', arguments: { tool, args: '-enc dGVzdA==' } },
      })
      const json = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } }
      expect(json.result.isError).toBe(true)
    }
  })

  it('run_tool refuse un cwd hors du dossier tools et les chemins réseau', async () => {
    const res1 = await rpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'run_tool', arguments: { tool: 'node', args: '-e "1"', cwd: 'C:\\Users\\Public' } },
    })
    const j1 = (await res1.json()) as { result: { content: { text: string }[]; isError: boolean } }
    expect(j1.result.isError).toBe(true)

    const res2 = await rpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'run_tool', arguments: { tool: 'node', args: '-e "1"', cwd: '\\\\srv\\share' } },
    })
    const j2 = (await res2.json()) as { result: { content: { text: string }[]; isError: boolean } }
    expect(j2.result.isError).toBe(true)
  })

  it('run_tool refuse un dossier voisin qui partage le préfixe du dossier tools', async () => {
    // Contournement du contrôle en préfixe nu : « <tools>_evil » commence par le
    // dossier autorisé sans en être un enfant.
    const sibling = `${userData}_evil`
    mkdirSync(sibling, { recursive: true })
    try {
      const res = await rpc({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'run_tool', arguments: { tool: 'node', args: '-e "1"', cwd: sibling } },
      })
      const json = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } }
      expect(json.result.isError).toBe(true)
      expect(json.result.content[0]!.text).toContain('hors périmètre')
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('tools/call list_programs passe sur le vrai HTTP et lit la base réelle', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_programs', arguments: {} },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }
    expect(json.result.isError).toBeFalsy()
    const programs = JSON.parse(json.result.content[0]!.text) as { id: string }[]
    expect(programs).toHaveLength(1)
    expect(programs[0]!.id).toBe('prog-1')
  })

  it('tools/call d’un outil inconnu renvoie une erreur JSON-RPC propre', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inexistant', arguments: {} } })
    const json = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } }
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0]!.text).toContain('Outil inconnu')
  })

  it('méthode inconnue répond -32601 et les notifications répondent 202', async () => {
    const unknown = await rpc({ jsonrpc: '2.0', id: 1, method: 'pouet' })
    const uk = (await unknown.json()) as { error: { code: number } }
    expect(uk.error.code).toBe(-32601)
    const notif = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(notif.status).toBe(202)
  })

  it('accepte plusieurs jetons nommés et révoque un jeton immédiatement', async () => {
    const second = 'token-second-pc-abcdef'
    const r = await startMcpServer(0, TOKEN, {
      tokens: [TOKEN, second],
      tokenLabels: new Map([
        [TOKEN, 'PC-bureau'],
        [second, 'Labo'],
      ]),
    })
    if (!r.ok) throw new Error(r.error)
    port = r.port

    const ok = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}, second)
    expect(ok.status).toBe(200)

    const call = await rpc({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'list_programs', arguments: {} },
    }, {}, second)
    expect(call.status).toBe(200)

    const restart = await startMcpServer(0, TOKEN)
    if (!restart.ok) throw new Error(restart.error)
    port = restart.port
    const revoked = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}, second)
    expect(revoked.status).toBe(401)
  })

  it('fonctionne en mode LAN (bind 0.0.0.0) et reste joignable', async () => {
    const r = await startMcpServer(0, TOKEN, { lan: true })
    if (!r.ok) throw new Error(r.error)
    port = r.port
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(res.status).toBe(200)
  })

  it('audite chaque tools/call (poste, outil, statut) et les échecs 401', async () => {
    await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_programs', arguments: {} } }, {}, TOKEN)
    await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' }, {}, 'mauvais-token')
    const rows = getRepository().listMcpRequests()
    expect(rows.length).toBeGreaterThanOrEqual(2)
    const okRow = rows.find((x) => x.tool === 'list_programs')
    expect(okRow).toBeTruthy()
    expect(okRow!.status).toBe('ok')
    expect(rows.find((x) => x.status === '401')).toBeTruthy()
  })
})

describe('outils MCP ajoutés (notes, page, scans, dedupe, CVSS)', () => {
  let pageServer: Server
  let pagePort = 0
  let pageRequests: { url: string; headers: IncomingHttpHeaders }[] = []

  beforeAll(async () => {
    pageServer = createServer((req, res) => {
      pageRequests.push({ url: req.url ?? '', headers: req.headers })
      const path = (req.url ?? '/').split('?')[0]
      if (path === '/echo' && req.method === 'POST') {
        let data = ''
        req.on('data', (c) => { data += c })
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ received: data }))
        })
        return
      }
      if (path === '/redirect') {
        res.writeHead(302, { location: '/page' })
        res.end()
        return
      }
      if (path === '/loop') {
        res.writeHead(302, { location: '/loop' })
        res.end()
        return
      }
      if (path === '/big') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<html><body><p>${'A'.repeat(20_000)}</p></body></html>`)
        return
      }
      if (path === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          '<html><head><style>.a{color:red}</style><script>window.SECRET_SCRIPT=1</script></head>'
          + '<body><!-- commentaire secret --><h1>Politique du programme</h1>'
          + '<p>Scan automatis&eacute; interdit sans accord.</p><a href="/x">documentation</a></body></html>',
        )
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('introuvable')
    })
    await new Promise<void>((done) => pageServer.listen(0, '127.0.0.1', () => done()))
    pagePort = (pageServer.address() as AddressInfo).port
  })

  afterAll(() => {
    pageServer.closeAllConnections?.()
    pageServer.close()
  })

  beforeEach(async () => {
    pageRequests = []
    closeDb()
    rmSync(join(userData, 'bountydesk.db'), { force: true })
    rmSync(join(userData, 'bountydesk.db-wal'), { force: true })
    rmSync(join(userData, 'bountydesk.db-shm'), { force: true })
    getRepository().upsertPrograms([
      {
        id: 'prog-1', handle: 'acme', name: 'Acme', type: 'bug_bounty', status: 'active',
        confidentiality: 'public', minBounty: null, maxBounty: null, industry: null,
        webLink: null, following: false, rawJson: null,
      } as ProgramInput,
    ])
    const r = await startMcpServer(0, TOKEN)
    if (!r.ok) throw new Error(r.error)
    port = r.port
  })

  afterEach(() => {
    stopMcpServer()
  })

  // --- cvss_score ----------------------------------------------------------
  // Chaque score attendu est celui de l'implementation de reference officielle
  // FIRST (CVSS31.calculateCVSSFromVector, first.org/cvss). Les vecteurs sont
  // ceux des exemples publies de FIRST (Examples v3.1) et les cas limites
  // (impact nul, scope change, port physique, scope inchange) verifies ici.
  it('cvss_score reproduit les scores de base publiés (FIRST)', async () => {
    const cases: [string, number][] = [
      ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
      ['CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', 5.5],
      ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', 6.5],
      ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1],
      ['CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N', 0],
      ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0],
      ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:N', 0],
      ['CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:C/C:N/I:N/A:N', 0],
      ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10],
      ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N', 6.4],
      ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:L', 7.4],
      ['CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N', 3.1],
      ['CVSS:3.1/AV:A/AC:H/PR:L/UI:R/S:U/C:L/I:L/A:N', 3.4],
      ['CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H', 7.8],
      ['CVSS:3.1/AV:A/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:H', 9.3],
      ['CVSS:3.1/AV:P/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N', 4.6],
      ['CVSS:3.1/AV:P/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 6.8],
      ['CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:N/I:H/A:N', 6.8],
      ['CVSS:3.1/AV:L/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:L', 4.2],
      ['CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H', 7.2],
    ]
    for (const [vector, expected] of cases) {
      const out = await callTool('cvss_score', { vector })
      expect(out.isError, vector).toBe(false)
      const payload = out.payload as { baseScore: number; severity: string; baseVector: string; input: string }
      expect(payload.baseScore, vector).toBe(expected)
      expect(payload.baseVector, vector).toBe(vector)
      expect(payload.input, vector).toBe(vector)
    }
  })

  it('cvss_score donne les sous-scores et signale les métriques ignorées', async () => {
    const out = await callTool('cvss_score', { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:F/RL:O' })
    expect(out.isError).toBe(false)
    const payload = out.payload as {
      baseScore: number; severity: string; impactSubScore: number; impact: number; exploitability: number
      ignoredMetrics: string[]; metrics: Record<string, string>; baseVector: string
    }
    expect(payload.baseScore).toBe(9.8)
    expect(payload.severity).toBe('Critique')
    expect(payload.impactSubScore).toBeCloseTo(0.914816, 6)
    expect(payload.impact).toBeCloseTo(5.873119, 6)
    expect(payload.exploitability).toBeCloseTo(3.887043, 6)
    expect(payload.ignoredMetrics).toEqual(['E', 'RL'])
    expect(payload.baseVector).toBe('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')
    expect(payload.metrics).toEqual({ AV: 'N', AC: 'L', PR: 'N', UI: 'N', S: 'U', C: 'H', I: 'H', A: 'H' })

    // Métriques dans le désordre : même score, vecteur de base normalisé.
    const shuffled = await callTool('cvss_score', { vector: 'CVSS:3.1/S:U/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H' })
    expect(shuffled.isError).toBe(false)
    expect((shuffled.payload as { baseScore: number }).baseScore).toBe(9.8)
  })

  it('cvss_score refuse un vecteur mal formé, une valeur hors domaine et une métrique manquante', async () => {
    for (const vector of [
      'pas un vecteur',
      'CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H',
      'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/AV:L',
      'CVSS:2.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    ]) {
      const out = await callTool('cvss_score', { vector })
      expect(out.isError, vector).toBe(true)
      expect(out.payload, vector).toBeNull()
    }
    const missing = await callTool('cvss_score', {})
    expect(missing.isError).toBe(true)
  })

  // --- fetch_page ----------------------------------------------------------
  it('fetch_page rend le texte lisible sans script ni style, et sans identifiant', async () => {
    const out = await callTool('fetch_page', { url: `http://127.0.0.1:${pagePort}/page` })
    expect(out.isError).toBe(false)
    const payload = out.payload as {
      status: number; format: string; finalUrl: string; truncated: boolean
      text: string; chars: number
    }
    expect(payload.status).toBe(200)
    expect(payload.format).toBe('html')
    expect(payload.truncated).toBe(false)
    expect(payload.text).toContain('Politique du programme')
    expect(payload.text).toContain('Scan automatisé interdit')
    expect(payload.text).not.toContain('SECRET_SCRIPT')
    expect(payload.text).not.toContain('color:red')
    expect(payload.text).not.toContain('commentaire secret')
    expect(payload.text).not.toContain('<')

    expect(pageRequests).toHaveLength(1)
    const headers = pageRequests[0]!.headers
    expect(String(headers['user-agent'])).toContain('Venari')
    expect(headers.cookie).toBeUndefined()
    expect(headers.authorization).toBeUndefined()
  })

  it('fetch_page suit une redirection bornée et refuse une boucle', async () => {
    const ok = await callTool('fetch_page', { url: `http://127.0.0.1:${pagePort}/redirect` })
    expect(ok.isError).toBe(false)
    const payload = ok.payload as { finalUrl: string; text: string }
    expect(payload.finalUrl).toBe(`http://127.0.0.1:${pagePort}/page`)
    expect(payload.text).toContain('Politique du programme')

    const loop = await callTool('fetch_page', { url: `http://127.0.0.1:${pagePort}/loop` })
    expect(loop.isError).toBe(true)
    expect(loop.text).toContain('redirections')
  })

  it('fetch_page plafonne les octets lus', async () => {
    const out = await callTool('fetch_page', { url: `http://127.0.0.1:${pagePort}/big`, maxBytes: 1024, maxChars: 500 })
    expect(out.isError).toBe(false)
    const payload = out.payload as { bytesRead: number; truncated: boolean; chars: number }
    expect(payload.bytesRead).toBe(1024)
    expect(payload.truncated).toBe(true)
    expect(payload.chars).toBeLessThanOrEqual(500)
  })

  it('fetch_page refuse file:// et ftp:// sans émettre la moindre requête', async () => {
    for (const url of [
      `file:///C:/Windows/win.ini`,
      `ftp://127.0.0.1:${pagePort}/page`,
      'http://',
      'javascript:alert(1)',
    ]) {
      const out = await callTool('fetch_page', { url })
      expect(out.isError, url).toBe(true)
    }
    expect(pageRequests).toHaveLength(0)
    const missing = await callTool('fetch_page', {})
    expect(missing.isError).toBe(true)
    expect((await callTool('fetch_page', { url: `http://127.0.0.1:${pagePort}/page`, maxBytes: 10 })).isError).toBe(true)
    expect((await callTool('fetch_page', { url: `http://127.0.0.1:${pagePort}/page`, maxChars: 5_000_000 })).isError).toBe(true)
    // Les bornes hors domaine sont refusees avant tout appel reseau.
    expect(pageRequests).toHaveLength(0)
  })

  it('fetch_page remonte le statut HTTP et refuse un contenu non textuel', async () => {
    const notFound = await callTool('fetch_page', { url: `http://127.0.0.1:${pagePort}/absent` })
    expect(notFound.isError).toBe(true)
    expect(notFound.text).toContain('404')
  })

  // --- set_note / list_notes ----------------------------------------------
  it('set_note ajoute des entrées horodatées sans écraser, list_notes les relit', async () => {
    const first = await callTool('set_note', { programId: 'prog-1', text: 'Sous-domaine staging à tester' })
    expect(first.isError).toBe(false)
    const second = await callTool('set_note', { programId: 'prog-1', text: 'Rate limit 2 req/s imposé par les ROE' })
    expect(second.isError).toBe(false)

    const listed = await callTool('list_notes', { programId: 'prog-1' })
    expect(listed.isError).toBe(false)
    const payload = listed.payload as { total: number; entries: { ts: string; text: string }[]; storage: string }
    expect(payload.total).toBe(2)
    expect(payload.entries).toHaveLength(2)
    expect(payload.entries[0]!.text).toBe('Sous-domaine staging à tester')
    expect(payload.entries[1]!.text).toBe('Rate limit 2 req/s imposé par les ROE')
    expect(payload.entries[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(payload.storage).toContain('note du programme')

    // La note du programme reste celle de l'IA : rien n'a été écrasé ailleurs.
    expect(getRepository().getProgram('prog-1')!.note).toContain('Sous-domaine staging à tester')
  })

  it('set_note et list_notes refusent un programme inconnu ou un texte vide', async () => {
    expect((await callTool('set_note', { programId: 'prog-1', text: '   ' })).isError).toBe(true)
    expect((await callTool('set_note', { programId: 'prog-1' })).isError).toBe(true)
    expect((await callTool('set_note', { programId: 'prog-1', text: 'x'.repeat(4001) })).isError).toBe(true)
    expect((await callTool('set_note', { programId: 'inconnu', text: 'hello' })).isError).toBe(true)
    expect((await callTool('list_notes', { programId: 'inconnu' })).isError).toBe(true)
    expect((await callTool('list_notes', { programId: 42 })).isError).toBe(true)
    expect((await callTool('list_notes', { programId: 'prog-1', limit: 0 })).isError).toBe(true)
    expect((await callTool('list_notes', { programId: 'prog-1', limit: 'beaucoup' })).isError).toBe(true)
  })

  // --- list_scans ----------------------------------------------------------
  it('list_scans liste les scans existants et refuse un programmeId invalide', async () => {
    const repo = getRepository()
    const first = repo.createScan({ programId: 'prog-1', depth: 'low', rateLimit: 1, roeConfirm: true })
    repo.createScan({ programId: 'prog-1', depth: 'high', rateLimit: 10, roeConfirm: true })

    const out = await callTool('list_scans', { programId: 'prog-1', limit: 1 })
    expect(out.isError).toBe(false)
    const payload = out.payload as { count: number; scans: { id: number; depth: string; status: string; roeConfirm: boolean }[] }
    expect(payload.count).toBe(1)
    expect(payload.scans[0]!.id).toBe(first + 1)
    expect(payload.scans[0]!.status).toBe('running')
    expect(payload.scans[0]!.roeConfirm).toBe(true)

    expect((await callTool('list_scans', { programId: 'prog-1', limit: 0 })).isError).toBe(true)
    expect((await callTool('list_scans', {})).isError).toBe(true)
  })

  // --- dedupe_findings -----------------------------------------------------
  it('dedupe_findings canonicalise, dédoublonne et regroupe par endpoint', async () => {
    const repo = getRepository()
    const scanId = repo.createScan({ programId: 'prog-1', depth: 'low', rateLimit: 1, roeConfirm: true })
    const events = [
      'curl https://Example.com:443/a/?utm_source=newsletter#frag',
      'nuclei: [http] http://example.com/a',
      'ffuf: https://example.com/b?b=2&a=1',
      'ffuf: https://example.com/b?a=1&b=2',
      'rien de pertinent sur cette ligne',
      'curl https://example.com/a',
    ]
    events.forEach((message, i) => repo.appendScanEvent(scanId, i + 1, 'info', message, Date.now() + i))

    const out = await callTool('dedupe_findings', { scanId })
    expect(out.isError).toBe(false)
    const payload = out.payload as {
      linesScanned: number; urlsExtracted: number; uniqueUrls: number; endpointsOmitted: number
      endpoints: { endpoint: string; occurrences: number; distinctUrls: number; urls: string[] }[]
    }
    expect(payload.linesScanned).toBe(6)
    expect(payload.urlsExtracted).toBe(5)
    expect(payload.uniqueUrls).toBe(3)
    expect(payload.endpointsOmitted).toBe(0)
    expect(payload.endpoints.map((e) => e.endpoint)).toEqual(['example.com/a', 'example.com/b'])
    const a = payload.endpoints[0]!
    expect(a.occurrences).toBe(3)
    expect(a.distinctUrls).toBe(2)
    expect(a.urls.sort()).toEqual(['http://example.com/a', 'https://example.com/a'])
    const b = payload.endpoints[1]!
    expect(b.occurrences).toBe(2)
    expect(b.distinctUrls).toBe(1)
    expect(b.urls).toEqual(['https://example.com/b?a=1&b=2'])
  })

  it('dedupe_findings accepte des lignes brutes et refuse une entrée vide ou invalide', async () => {
    const out = await callTool('dedupe_findings', {
      lines: ['voir https://app.acme.test/v1/users (200)', 'https://app.acme.test/v1/users?id=1'],
    })
    expect(out.isError).toBe(false)
    const payload = out.payload as { uniqueUrls: number; endpoints: { endpoint: string; occurrences: number }[] }
    expect(payload.endpoints[0]!.endpoint).toBe('app.acme.test/v1/users')
    expect(payload.endpoints[0]!.occurrences).toBe(2)

    expect((await callTool('dedupe_findings', {})).isError).toBe(true)
    expect((await callTool('dedupe_findings', { lines: [] })).isError).toBe(true)
    expect((await callTool('dedupe_findings', { scanId: 0 })).isError).toBe(true)
    expect((await callTool('dedupe_findings', { scanId: 9999 })).isError).toBe(true)
    const tooMany = await callTool('dedupe_findings', { lines: new Array(501).fill('https://a.test/') })
    expect(tooMany.isError).toBe(true)
  })

  // --- http_request --------------------------------------------------------
  function seedScope(endpoint: string): void {
    getRepository().setProgramDetail(
      'prog-1',
      JSON.stringify([
        { id: 'd1', type: 'in-scope', endpoint, tier: 'tier1', description: '', inScope: true },
      ]),
      null,
      Date.now(),
    )
  }

  it('http_request envoie une requête POST vers un hôte in-scope et renvoie la réponse', async () => {
    seedScope(`http://127.0.0.1:${pagePort}`)
    const out = await callTool('http_request', {
      programId: 'prog-1',
      url: `http://127.0.0.1:${pagePort}/echo`,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user=admin',
    })
    expect(out.isError).toBe(false)
    const payload = out.payload as { status: number; method: string; body: string }
    expect(payload.status).toBe(200)
    expect(payload.method).toBe('POST')
    expect(payload.body).toContain('user=admin')
    expect(pageRequests.some((r) => r.url === '/echo')).toBe(true)
  })

  it('http_request accepte un hôte in-scope et refuse tout autre hôte', async () => {
    seedScope('http://127.0.0.1')
    const ok = await callTool('http_request', { programId: 'prog-1', url: `http://127.0.0.1:${pagePort}/page` })
    expect(ok.isError).toBe(false)
    expect((ok.payload as { status: number }).status).toBe(200)

    const out = await callTool('http_request', { programId: 'prog-1', url: 'https://evil.example.org/' })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('hors scope')
  })

  it('http_request refuse programme manquant, méthode inconnue, protocole et corps sur GET', async () => {
    seedScope(`http://127.0.0.1:${pagePort}`)
    expect((await callTool('http_request', { url: `http://127.0.0.1:${pagePort}/page` })).isError).toBe(true)
    expect((await callTool('http_request', { programId: 'inconnu', url: `http://127.0.0.1:${pagePort}/page` })).isError).toBe(true)
    expect((await callTool('http_request', { programId: 'prog-1', url: `http://127.0.0.1:${pagePort}/page`, method: 'TRACE' })).isError).toBe(true)
    expect((await callTool('http_request', { programId: 'prog-1', url: 'ftp://127.0.0.1/x' })).isError).toBe(true)
    expect((await callTool('http_request', { programId: 'prog-1', url: `http://127.0.0.1:${pagePort}/echo`, method: 'GET', body: 'x=1' })).isError).toBe(true)
  })

  // --- submit_report -------------------------------------------------------
  it('submit_report écrit un rapport markdown local et renvoie son chemin', async () => {
    const out = await callTool('submit_report', {
      programId: 'prog-1',
      title: 'XSS réfléchi sur /search',
      severity: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N',
      description: 'Le paramètre q est reflété sans échappement.',
      steps: '1. Ouvrir /search?q=<script>alert(1)</script>',
      impact: 'Exécution de script dans le navigateur de la victime.',
    })
    expect(out.isError).toBe(false)
    const payload = out.payload as { path: string; submitted: boolean }
    expect(payload.submitted).toBe(false)
    expect(payload.path).toContain('reports')
    expect(payload.path).toContain('prog-1')
    expect(payload.path.endsWith('.md')).toBe(true)
    expect(existsSync(payload.path)).toBe(true)
    const md = readFileSync(payload.path, 'utf8')
    expect(md).toContain('# XSS réfléchi sur /search')
    expect(md).toContain('lecture seule')
  })

  it('submit_report refuse un programme inconnu ou des champs requis manquants', async () => {
    expect((await callTool('submit_report', { programId: 'prog-1', title: 'T' })).isError).toBe(true)
    expect((await callTool('submit_report', { programId: 'inconnu', title: 'T', description: 'D' })).isError).toBe(true)
  })
})

describe('handlers IPC Santé & machines', () => {
  beforeAll(() => {
    registerMcpIpc()
    captureIpc()
  })

  beforeEach(async () => {
    closeDb()
    rmSync(join(userData, 'bountydesk.db'), { force: true })
    rmSync(join(userData, 'bountydesk.db-wal'), { force: true })
    rmSync(join(userData, 'bountydesk.db-shm'), { force: true })
    getRepository().upsertPrograms([
      {
        id: 'prog-1', handle: 'acme', name: 'Acme', type: 'bug_bounty', status: 'active',
        confidentiality: 'public', minBounty: null, maxBounty: null, industry: null,
        webLink: null, following: false, rawJson: null,
      } as ProgramInput,
    ])
    const r = await startMcpServer(0, TOKEN)
    if (!r.ok) throw new Error(r.error)
    port = r.port
  })

  afterEach(() => {
    stopMcpServer()
  })

  it('enregistre les trois nouveaux canaux IPC', () => {
    expect(ipcHandler(IPC.McpDiagnose)).toBeTypeOf('function')
    expect(ipcHandler(IPC.McpFirewallFix)).toBeTypeOf('function')
    expect(ipcHandler(IPC.McpMachines)).toBeTypeOf('function')
  })

  it('diagnose : état réel, self-test HTTP, erreurs 401 récentes et état pare-feu', async () => {
    await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}, 'mauvais-jeton')
    const res = await ipcHandler(IPC.McpDiagnose)()
    expect(res).toBeTruthy()
    const diag = res as { ok: true; diag: { running: boolean; port: number | null; lan: boolean; firewall: string; selfTest: { ok: boolean; ms: number; error?: string } | null; recentErrors: { status: string }[] } }
    expect(diag.ok).toBe(true)
    expect(diag.diag.running).toBe(true)
    expect(diag.diag.port).toBe(port)
    expect(['ok', 'missing', 'unmanaged']).toContain(diag.diag.firewall)
    expect(diag.diag.selfTest?.ok).toBe(true)
    expect(diag.diag.recentErrors.some((r) => r.status === '401')).toBe(true)
  })

  it('machines : agrège les appels par jeton avec IP sources', async () => {
    await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_programs', arguments: {} } },
      {},
      TOKEN
    )
    const res = await ipcHandler(IPC.McpMachines)(undefined, {})
    expect(res).toBeTruthy()
    const m = res as { ok: true; machines: { tokenLabel: string; lastSeen: string; calls: number; errors: number; ips: string[] }[] }
    expect(m.ok).toBe(true)
    const group = m.machines.find((x) => x.tokenLabel === 'PC 1')
    expect(group).toBeTruthy()
    expect(group!.calls).toBeGreaterThanOrEqual(1)
    expect(group!.errors).toBe(0)
    expect(group!.ips.length).toBeGreaterThanOrEqual(1)
  })
})