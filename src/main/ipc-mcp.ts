import { clipboard, ipcMain, Notification } from 'electron'
import { execFile } from 'node:child_process'
import { z } from 'zod'
import {
  IPC,
  type AgentSessionDecideResult,
  type AgentSessionRequestResult,
  type AgentSessionsResult,
  type AgentStatusesResult,
  type AgentTokenInfo,
  type AgentTokenAddResult,
  type AgentTokenRevokeResult,
  type AgentTokensResult,
  type AgentViewTokenResult,
  type DbResult,
  type McpDiagnoseInfo,
  type McpDiagnoseResult,
  type McpFirewallFixResult,
  type McpMachinesResult,
  type McpPairingCancelResult,
  type McpPairingCreateResult,
  type McpRegenerateResult,
  type McpRequestsResult,
  type McpSetEnabledResult,
  type McpStatusInfo,
  type McpTokenAddResult,
  type McpTokenInfo,
  type McpTokenRevokeResult,
  type SecretCopyResult,
} from '../shared/ipc'
import {
  loadMcpConfig,
  saveMcpConfig,
  type McpToken,
} from './storage'
import { getRepository } from './db'
import {
  addMcpToken,
  generateMcpToken,
  generateMcpTokenId,
  getMcpPairId,
  getMcpStatus,
  getPrimaryMcpToken,
  isPrivateNetwork,
  maskToken,
  setPairingRedeem,
  startMcpServer,
  stopMcpServer,
} from './services/mcp/server'
import { createPairingCode, currentPairing, redeemPairingCode, resetPairing } from './services/mcp/pairing'
import {
  agentSessions,
  agentStatuses,
  decideSession,
  endSessionByViewToken,
  requestSession,
  sessionAgentToken,
} from './services/mcp/agents'
import { getViewTokenForSender, openAgentView } from './view'
import { getMainWindow } from './window'

const DEFAULT_PORT = 8787

function joinStatus(info: McpStatusInfo): McpStatusInfo {
  const cfg = loadMcpConfig()
  return {
    enabled: cfg.enabled,
    running: info.running,
    port: info.port ?? cfg.port,
    lan: cfg.lan,
    hosts: info.hosts,
    masked: maskToken(cfg.tokens[0]?.token),
    tokens: cfg.tokens.map(toTokenInfo),
  }
}

function toTokenInfo(t: McpToken): McpTokenInfo {
  return { id: t.id, label: t.label, masked: maskToken(t.token) }
}

function toAgentTokenInfo(t: McpToken): AgentTokenInfo {
  return { id: t.id, label: t.label, masked: maskToken(t.token) }
}

/** Contenu exact des extraits de configuration affiches dans Reglages, mais avec le vrai jeton. */
function snippetHost(info: McpStatusInfo): string {
  return info.lan && info.hosts.length > 0 ? info.hosts[0]! : '127.0.0.1'
}

function mcpConfigSnippet(token: string, info: McpStatusInfo, port: number): string {
  return `{
  "bountydesk": {
    "type": "remote",
    "url": "http://${snippetHost(info)}:${port}/mcp",
    "headers": {
      "Authorization": "Bearer ${token}",
      "Content-Type": "application/json"
    }
  }
}`
}

function agentConfigSnippet(token: string, info: McpStatusInfo, port: number): string {
  return `{\n  "server": "${snippetHost(info)}",\n  "port": ${port},\n  "token": "${token}"\n}`
}

function withLabels(tokens: McpToken[]): Map<string, string> {
  return new Map(tokens.map((t) => [t.token, t.label]))
}

function handleError(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

const FIREWALL_RULE = 'Venari MCP'

function runNetsh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('netsh', ['advfirewall', 'firewall', ...args], { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      })
    })
  })
}

/**
 * netsh ne detaille les champs d'une regle que si elle existe ; le nom y est
 * recopie tel quel, quelle que soit la langue de l'interface (l'etiquette est
 * localisee, pas la valeur). Une recherche sur l'ancien nom « bountydesk »
 * ne renvoyait donc jamais 'ok' depuis le renommage en Venari.
 */
export function netshRuleFound(r: { code: number; stdout: string }): boolean {
  return r.code === 0 && r.stdout.toLowerCase().includes(FIREWALL_RULE.toLowerCase())
}

function runCli(
  cmd: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      })
    })
  })
}

/** État du pare-feu Linux (ufw / firewalld), sinon 'unmanaged'. */
async function linuxFirewallState(port: number): Promise<McpDiagnoseInfo['firewall']> {
  if (process.platform !== 'linux') return 'unmanaged'
  const ufw = await runCli('ufw', ['status']).catch(() => ({ code: -1, stdout: '', stderr: '' }))
  if (ufw.code === 0) {
    return ufw.stdout.includes(`${port}/tcp`) ? 'ok' : 'missing'
  }
  const firewalld = await runCli('firewall-cmd', ['--state']).catch(() => ({ code: -1, stdout: '', stderr: '' }))
  if (firewalld.code === 0) {
    const listed = await runCli('firewall-cmd', ['--list-ports']).catch(() => ({ code: -1, stdout: '', stderr: '' }))
    if (listed.code === 0 && listed.stdout.includes(`${port}/tcp`)) return 'ok'
    // Les regles riches (sources privees) n'apparaissent pas dans --list-ports.
    const rich = await runCli('firewall-cmd', ['--list-rich-rules']).catch(() => ({ code: -1, stdout: '', stderr: '' }))
    return rich.code === 0 && rich.stdout.includes(`port=${port}`) ? 'ok' : 'missing'
  }
  return 'unmanaged'
}

async function firewallState(): Promise<McpDiagnoseInfo['firewall']> {
  if (process.platform !== 'win32') {
    const port = getMcpStatus().port
    return port ? linuxFirewallState(port) : 'unmanaged'
  }
  try {
    const r = await runNetsh(['show', 'rule', `name=${FIREWALL_RULE}`])
    if (netshRuleFound(r)) return 'ok'
    return 'missing'
  } catch {
    return 'unmanaged'
  }
}

async function selfTest(): Promise<McpDiagnoseInfo['selfTest']> {
  const info = getMcpStatus()
  const port = info.port
  const token = getPrimaryMcpToken()
  if (!info.running || !port || !token) return null
  const start = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      // Sans plafond, un serveur qui accepte sans répondre bloquerait
      // indéfiniment la promesse IPC `mcp:diagnose`.
      signal: AbortSignal.timeout(5000),
    })
    const body = await res.text()
    const ok = res.status === 200 && body.includes('jsonrpc')
    return { ok, ms: Date.now() - start, error: ok ? undefined : `HTTP ${res.status} : ${body.slice(0, 120)}` }
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}

function richRule(cidr: string, port: number): string {
  return `rule family=ipv4 source address=${cidr} port port=${port} protocol=tcp accept`
}

/** Sources autorisees : uniquement le RFC1918, puisque le mode LAN est refuse hors reseau prive. */
const PRIVATE_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']

/** Script PowerShell eleve (invite UAC), reserve a la creation et au retrait de la regle. */
function runElevated(script: string): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const ps =
    'Start-Process -FilePath powershell.exe ' +
    `-ArgumentList "-NoProfile","-NonInteractive","-WindowStyle","Hidden","-ExecutionPolicy","Bypass","-EncodedCommand","${encoded}" ` +
    '-Verb RunAs -Wait'
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 30000 },
      (err) => (err ? reject(err) : resolve())
    )
  })
}

/** Ouvre le port MCP sur les seules sources privees, via ufw (polkit) ou firewalld. */
async function runLinuxFirewallFix(port: number): Promise<{ ok: boolean; error?: string }> {
  let ufwOk = true
  for (const cidr of PRIVATE_CIDRS) {
    const r = await runCli('pkexec', [
      'ufw', 'allow', 'proto', 'tcp', 'from', cidr, 'to', 'any', 'port', String(port), 'comment', FIREWALL_RULE
    ])
    if (r.code !== 0) ufwOk = false
  }
  if (ufwOk) return { ok: true }
  let fdOk = true
  for (const cidr of PRIVATE_CIDRS) {
    const r = await runCli('pkexec', ['firewall-cmd', '--permanent', `--add-rich-rule=${richRule(cidr, port)}`])
    if (r.code !== 0) fdOk = false
  }
  if (!fdOk) {
    return { ok: false, error: `Impossible d’ouvrir le port ${port} sur les réseaux privés.` }
  }
  await runCli('pkexec', ['firewall-cmd', '--reload'])
  return { ok: true }
}

/**
 * Retire la regle pare-feu. Best effort : un UAC refuse ne doit pas empecher la
 * desactivation du serveur. Sans regle, plus rien n'ecoute de toute facon.
 */
async function runFirewallRemove(port: number | null): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await runElevated(`netsh advfirewall firewall delete rule name="${FIREWALL_RULE}"`)
      return
    }
    if (process.platform !== 'linux' || !port) return
    for (const cidr of PRIVATE_CIDRS) {
      await runCli('pkexec', [
        'ufw', 'delete', 'allow', 'proto', 'tcp', 'from', cidr, 'to', 'any', 'port', String(port), 'comment', FIREWALL_RULE
      ])
      await runCli('pkexec', ['firewall-cmd', '--permanent', `--remove-rich-rule=${richRule(cidr, port)}`])
    }
    await runCli('pkexec', ['firewall-cmd', '--reload'])
  } catch {
    // Sans consequence : la regle est limitee au programme, elle n'expose rien
    // tant que le port n'ecoute pas.
  }
}

async function runFirewallFix(): Promise<{ ok: boolean; firewall: McpDiagnoseInfo['firewall']; error?: string }> {
  if (process.platform !== 'win32') {
    const port = getMcpStatus().port
    if (process.platform !== 'linux' || !port) {
      return { ok: false, firewall: 'unmanaged', error: 'Gestion du pare-feu non applicable sur cette plateforme' }
    }
    const fixed = await runLinuxFirewallFix(port)
    const state = await linuxFirewallState(port)
    return { ok: fixed.ok && state === 'ok', firewall: state, error: fixed.ok ? undefined : fixed.error }
  }
  const bin = process.execPath
  const script =
    `netsh advfirewall firewall delete rule name="${FIREWALL_RULE}" ; ` +
    // profile=private : la regle ne s'applique que sur un reseau prive, la ou le
    // mode LAN est autorise. profile=any laissait le port joignable sur un reseau public.
    `netsh advfirewall firewall add rule name="${FIREWALL_RULE}" dir=in action=allow program="${bin}" enable=yes profile=private`
  try {
    await runElevated(script)
  } catch (err) {
    return { ok: false, firewall: 'missing', error: err instanceof Error ? err.message : String(err) }
  }
  const state = await firewallState()
  return { ok: state === 'ok', firewall: state, error: state === 'ok' ? undefined : 'La règle n’a pas été créée (UAC refusé ?)' }
}

async function restartIfRunning(cfg: {
  enabled: boolean
  port: number | null
  lan: boolean
  tokens: McpToken[]
  agents?: McpToken[]
}): Promise<void> {
  const info = getMcpStatus()
  if (!info.running) return
  const primary = cfg.tokens[0]?.token
  if (!primary) return
  const target = info.port ?? cfg.port ?? DEFAULT_PORT
  const started = await startMcpServer(target, primary, {
    lan: cfg.lan,
    tokens: cfg.tokens.map((t) => t.token),
    tokenLabels: withLabels(cfg.tokens),
    agentTokens: cfg.agents ?? [],
  })
  // Le redémarrage échoue (port pris ?) : il faut le dire, sinon l'utilisateur
  // croit son nouveau jeton actif alors que le serveur tourne encore à l'ancien.
  if (!started.ok) throw new Error(started.error)
}

export function registerMcpIpc(): void {
  // L'appairage echange un code a usage unique contre un jeton dedie. Le jeton
  // est ajoute au serveur *sans redemarrage* (la requete /pair en cours serait
  // coupee) puis persiste, pour qu'un redemarrage le conserve.
  setPairingRedeem(async (code) => {
    const redeemed = redeemPairingCode(code)
    if (!redeemed.ok) return redeemed
    const cfg = loadMcpConfig()
    const id = generateMcpTokenId()
    const token = generateMcpToken()
    const label = 'Poste appairé'
    const tokens = [...cfg.tokens, { id, label, token }]
    saveMcpConfig({ enabled: cfg.enabled, port: cfg.port, lan: cfg.lan, tokens, agents: cfg.agents })
    addMcpToken(token, label)
    return { ok: true, token, label }
  })

  ipcMain.handle(IPC.McpStatus, (): McpStatusInfo => {
    return joinStatus(getMcpStatus())
  })

  ipcMain.handle(IPC.McpRegenerateToken, async (): Promise<McpRegenerateResult> => {
    try {
      const cfg = loadMcpConfig()
      const token = generateMcpToken()
      const tokens = cfg.tokens.length > 0 ? [...cfg.tokens] : [{ id: 'primary', label: 'PC principal', token }]
      tokens[0] = { ...tokens[0]!, token }
      saveMcpConfig({ enabled: cfg.enabled, port: cfg.port, lan: cfg.lan, tokens, agents: cfg.agents })
      await restartIfRunning({ enabled: cfg.enabled, port: cfg.port, lan: cfg.lan, tokens, agents: cfg.agents })
      const info = getMcpStatus()
      return { ok: true, id: tokens[0]!.id, masked: maskToken(token), status: joinStatus(info) }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.McpTokenAdd, async (_event, raw: unknown): Promise<McpTokenAddResult> => {
    try {
      const { label } = z.object({ label: z.string().trim().min(1).max(60) }).parse(raw)
      const cfg = loadMcpConfig()
      const newId = generateMcpTokenId()
      const token = generateMcpToken()
      const tokens = [...cfg.tokens, { id: newId, label, token }]
      saveMcpConfig({ enabled: cfg.enabled, port: cfg.port, lan: cfg.lan, tokens, agents: cfg.agents })
      await restartIfRunning({ enabled: cfg.enabled, port: cfg.port, lan: cfg.lan, tokens, agents: cfg.agents })
      return { ok: true, id: newId, masked: maskToken(token), status: joinStatus(getMcpStatus()) }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.McpTokenRevoke, async (_event, raw: unknown): Promise<McpTokenRevokeResult> => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(100) }).parse(raw)
      const cfg = loadMcpConfig()
      if (cfg.tokens.length <= 1) {
        return { ok: false as const, error: 'Au moins un jeton est requis : révoquer ce jeton couperait tous les clients.' }
      }
      const tokens = cfg.tokens.filter((t) => t.id !== id)
      if (tokens.length === cfg.tokens.length) {
        return { ok: false as const, error: 'Jeton inconnu.' }
      }
      saveMcpConfig({ enabled: cfg.enabled, port: cfg.port, lan: cfg.lan, tokens, agents: cfg.agents })
      await restartIfRunning({ enabled: cfg.enabled, port: cfg.port, lan: cfg.lan, tokens, agents: cfg.agents })
      return { ok: true, status: joinStatus(getMcpStatus()) }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.McpSetEnabled, async (_event, raw: unknown): Promise<McpSetEnabledResult> => {
    try {
      const { enabled, port, lan } = z
        .object({
          enabled: z.boolean(),
          port: z.number().int().min(1024).max(65535).nullable().optional(),
          lan: z.boolean().optional(),
        })
        .parse(raw)
      const cfg = loadMcpConfig()
      if (enabled) {
        if (cfg.tokens.length === 0) {
          cfg.tokens = [{ id: 'primary', label: 'PC principal', token: generateMcpToken() }]
        }
        const lanOpt = lan ?? cfg.lan
        if (lanOpt && !isPrivateNetwork()) {
          return {
            ok: false,
            error:
              'Exposition réseau refusée : le réseau actif n’est pas privé (10/8, 172.16/12, 192.168/16). ' +
              'Venari n’écoute que sur 127.0.0.1 ici.',
          }
        }
        const targetPort = port ?? cfg.port ?? DEFAULT_PORT
        const primary = cfg.tokens[0]!.token
        const started = await startMcpServer(targetPort, primary, {
          lan: lanOpt,
          tokens: cfg.tokens.map((t) => t.token),
          tokenLabels: withLabels(cfg.tokens),
          agentTokens: cfg.agents ?? [],
        })
        if (!started.ok) return { ok: false, error: started.error }
        saveMcpConfig({ enabled: true, port: started.port, lan: lanOpt, tokens: cfg.tokens, agents: cfg.agents })
        return { ok: true, status: joinStatus(getMcpStatus()) }
      }
      const wasRunning = getMcpStatus().running
      const exposedPort = getMcpStatus().port
      stopMcpServer()
      saveMcpConfig({ enabled: false, port: cfg.port, lan: cfg.lan, tokens: cfg.tokens, agents: cfg.agents })
      // La regle n'a de sens que tant que le port ecoute : on la retire avec le serveur.
      if (wasRunning) await runFirewallRemove(exposedPort)
      return { ok: true, status: joinStatus(getMcpStatus()) }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.McpRequests, (_event, raw: unknown): McpRequestsResult => {
    try {
      const { limit } = z.object({ limit: z.number().int().min(1).max(500).optional() }).parse(raw)
      const rows = getRepository()
        .listMcpRequests(limit ?? 100)
        .map((r) => ({
          id: r.id,
          ts: r.ts,
          tokenLabel: r.token_label,
          tool: r.tool,
          args: r.args_json,
          status: r.status,
          ms: r.ms,
          remoteIp: r.remote_ip ?? '',
        }))
      return { ok: true, rows }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.McpDiagnose, async (): Promise<McpDiagnoseResult> => {
    try {
      const info = getMcpStatus()
      const [firewall, self] = await Promise.all([firewallState(), selfTest()])
      const recentErrors = info.running
        ? getRepository()
            .listMcpRequests(50)
            .filter((r) => r.status === '401' || r.status === 'error')
            .map((r) => ({
              id: r.id,
              ts: r.ts,
              tokenLabel: r.token_label,
              tool: r.tool,
              args: r.args_json,
              status: r.status,
              ms: r.ms,
              remoteIp: r.remote_ip ?? '',
            }))
        : []
      const diag: McpDiagnoseInfo = {
        running: info.running,
        port: info.port,
        lan: info.lan,
        firewall,
        selfTest: self,
        recentErrors,
      }
      return { ok: true, diag }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.McpFirewallFix, async (): Promise<McpFirewallFixResult> => {
    try {
      const r = await runFirewallFix()
      if (r.ok) return { ok: true, firewall: r.firewall }
      return { ok: false, error: r.error ?? 'Échec de création de la règle pare-feu' }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.McpMachines, (_event, raw: unknown): McpMachinesResult => {
    try {
      const { limit } = z.object({ limit: z.number().int().min(1).max(200).optional() }).parse(raw)
      const machines = getRepository()
        .mcpMachines(limit ?? 50)
        .map((m) => ({
          tokenLabel: m.tokenLabel,
          lastSeen: m.lastSeen,
          calls: m.calls,
          errors: m.errors,
          ips: (m.ip ?? '').split(',').filter(Boolean),
        }))
      return { ok: true, machines }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.McpPairingCreate, (): McpPairingCreateResult => {
    try {
      const info = getMcpStatus()
      if (!info.running) {
        return { ok: false, error: 'Activez le serveur MCP avant d’appairer un poste.' }
      }
      const pairId = getMcpPairId()
      if (!pairId) {
        return { ok: false, error: 'Paire indisponible : redémarrez le serveur MCP.' }
      }
      // Un code deja actif est renvoye tel quel : regenerer a chaque clic
      // invaliderait un code que l'utilisateur vient de dicter.
      const pairing = currentPairing() ?? createPairingCode()
      return {
        ok: true,
        pairing: {
          code: pairing.code,
          expiresAt: pairing.expiresAt,
          pairId,
          port: info.port,
          lan: info.lan,
          hosts: info.hosts,
        },
      }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.McpPairingCancel, (): McpPairingCancelResult => {
    resetPairing()
    return { ok: true }
  })

  ipcMain.handle(IPC.AgentTokens, (): AgentTokensResult => {
    try {
      const cfg = loadMcpConfig()
      const info = getMcpStatus()
      return {
        ok: true,
        port: info.port ?? cfg.port,
        hosts: info.hosts,
        tokens: cfg.agents.map(toAgentTokenInfo),
      }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.AgentTokenAdd, async (_event, raw: unknown): Promise<AgentTokenAddResult> => {
    try {
      const { label } = z.object({ label: z.string().trim().min(1).max(60) }).parse(raw)
      const cfg = loadMcpConfig()
      const newId = generateMcpTokenId()
      const token = generateMcpToken()
      const agents = [...cfg.agents, { id: newId, label, token }]
      saveMcpConfig({ enabled: cfg.enabled, port: cfg.port, lan: cfg.lan, tokens: cfg.tokens, agents })
      await restartIfRunning({ enabled: cfg.enabled, port: cfg.port, lan: cfg.lan, tokens: cfg.tokens, agents })
      const info = getMcpStatus()
      return {
        ok: true,
        id: newId,
        masked: maskToken(token),
        port: info.port ?? cfg.port,
        hosts: info.hosts,
        tokens: agents.map(toAgentTokenInfo),
      }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.AgentTokenRevoke, async (_event, raw: unknown): Promise<AgentTokenRevokeResult> => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(100) }).parse(raw)
      const cfg = loadMcpConfig()
      const agents = cfg.agents.filter((t) => t.id !== id)
      if (agents.length === cfg.agents.length) {
        return { ok: false as const, error: 'Jeton d’agent inconnu.' }
      }
      saveMcpConfig({ enabled: cfg.enabled, port: cfg.port, lan: cfg.lan, tokens: cfg.tokens, agents })
      await restartIfRunning({ enabled: cfg.enabled, port: cfg.port, lan: cfg.lan, tokens: cfg.tokens, agents })
      const info = getMcpStatus()
      return {
        ok: true,
        port: info.port ?? cfg.port,
        hosts: info.hosts,
        tokens: agents.map(toAgentTokenInfo),
      }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.AgentStatuses, (): AgentStatusesResult => {
    try {
      return { ok: true, agents: agentStatuses() }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.AgentSessions, (): AgentSessionsResult => {
    try {
      return { ok: true, sessions: agentSessions() }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.AgentSessionRequest, (_event, raw: unknown): AgentSessionRequestResult => {
    try {
      const { tokenId } = z.object({ tokenId: z.string().min(1).max(100) }).parse(raw)
      const r = requestSession(tokenId)
      if ('row' in r) {
        const row = r.row
        const main = getMainWindow()
        const n = new Notification({
          title: 'Venari · Demande de session',
          body: `${row.agentLabel || 'Machine distante'} · ${row.remoteIp || '—'} demande à s'afficher`,
        })
        n.on('click', () => {
          main?.show()
          main?.focus()
        })
        n.show()
        main?.flashFrame(true)
        return { ok: true, session: row }
      }
      return { ok: true, session: null }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.AgentSessionDecide, async (_event, raw: unknown): Promise<AgentSessionDecideResult> => {
    try {
      const { sessionId, approve } = z.object({ sessionId: z.number().int().min(1), approve: z.boolean() }).parse(raw)
      const r = decideSession(sessionId, approve)
      if (!r.ok) return r
      if (approve && r.viewToken) {
        const cfg = loadMcpConfig()
        const row = sessionAgentToken(r.session.id)
        const label = cfg.agents.find((a) => a.token === row)?.label ?? r.session.agentLabel
        openAgentView(r.viewToken, label || 'PC distant')
      }
      return { ok: true, session: r.session }
    } catch (err) {
      return handleError(err)
    }
  })

  // Le jeton n'est servi qu'a une fenetre de vue que le processus principal a
  // lui-meme ouverte : la fenetre principale ne l'obtient pas.
  // Copie un secret dans le presse-papier. Le renderer choisit *quel* secret,
  // jamais son contenu : il ne voit que le masque renvoye par les autres canaux.
  ipcMain.handle(IPC.SecretCopy, async (_event, raw: unknown): Promise<SecretCopyResult> => {
    try {
      const { kind, id } = z
        .object({
          kind: z.enum(['mcpToken', 'agentToken', 'mcpConfig', 'agentConfig']),
          id: z.string().min(1).max(100).optional(),
        })
        .parse(raw)
      const cfg = loadMcpConfig()
      const info = getMcpStatus()
      const primary = cfg.tokens[0]?.token
      const port = info.port ?? cfg.port ?? DEFAULT_PORT
      let text: string | null = null
      if (kind === 'mcpToken') {
        text = cfg.tokens.find((t) => t.id === id)?.token ?? null
      } else if (kind === 'agentToken') {
        text = cfg.agents.find((t) => t.id === id)?.token ?? null
      } else if (kind === 'mcpConfig') {
        if (primary) text = mcpConfigSnippet(primary, info, port)
      } else {
        const agentToken = cfg.agents[0]?.token
        if (agentToken) text = agentConfigSnippet(agentToken, info, port)
      }
      if (!text) return { ok: false, error: 'Aucun jeton à copier pour cette entrée.' }
      clipboard.writeText(text)
      return { ok: true }
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(IPC.AgentViewToken, (event): AgentViewTokenResult => {
    const token = getViewTokenForSender(event.sender.id)
    if (!token) return { ok: false, error: 'Cette fenêtre n’est pas une fenêtre de vue distante.' }
    return { ok: true, token }
  })

  ipcMain.handle(IPC.AgentSessionEnd, (_event, raw: unknown): DbResult => {
    try {
      const { viewToken } = z.object({ viewToken: z.string().min(1).max(200) }).parse(raw)
      endSessionByViewToken(viewToken)
      return { ok: true }
    } catch (err) {
      return handleError(err)
    }
  })
}

export function restoreAutostartMcp(): void {
  const cfg = loadMcpConfig()
  if (cfg.enabled && cfg.tokens.length > 0 && cfg.port) {
    const primary = cfg.tokens[0]!.token
    // Sécurité : ne jamais re-brancher 0.0.0.0 sur un réseau public/hotspot.
    // Si le réseau actif est privé (10/8, 172.16/12, 192.168/16), on honore cfg.lan.
    const lan = cfg.lan && isPrivateNetwork()
    void startMcpServer(cfg.port, primary, {
      lan,
      tokens: cfg.tokens.map((t) => t.token),
      tokenLabels: withLabels(cfg.tokens),
      agentTokens: cfg.agents ?? [],
    }).catch((err: unknown) => {
      // Jamais de rejection silencieuse au démarrage (port occupé, etc.).
      console.error('Venari : démarrage automatique du serveur MCP échoué :', err)
    })
  }
}