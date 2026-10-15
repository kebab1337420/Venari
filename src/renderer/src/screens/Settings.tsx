import { useEffect, useRef, useState } from 'react'
import { Api } from '../api'
import type {
  AgentStatusInfo,
  AgentTokenInfo,
  McpDiagnoseInfo,
  McpMachineInfo,
  McpRequestRow,
  McpStatusInfo,
  RemoteSessionInfo,
  SecretCopyKind
} from '../../../shared/ipc'

interface Props {
  onLogout: () => void
}

export function SettingsScreen({ onLogout }: Props) {
  const [mcp, setMcp] = useState<McpStatusInfo | null>(null)
  const [port, setPort] = useState('8787')
  const [lanLocal, setLanLocal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [requests, setRequests] = useState<McpRequestRow[]>([])
  const [diag, setDiag] = useState<McpDiagnoseInfo | null>(null)
  const [machines, setMachines] = useState<McpMachineInfo[]>([])
  const [agents, setAgents] = useState<AgentStatusInfo[]>([])
  const [agentTokens, setAgentTokens] = useState<AgentTokenInfo[]>([])
  const [agentNewLabel, setAgentNewLabel] = useState('')
  const [session, setSession] = useState<RemoteSessionInfo | null>(null)
  const [sessionHistory, setSessionHistory] = useState<RemoteSessionInfo[]>([])
  const pendingRef = useRef(0)
  // Battement d'une seconde pendant qu'une demande de session attend une
  // décision : le compte à rebours et sa couleur restent exacts sans
  // recharger quoi que ce soit.
  const [, setPendingTick] = useState(0)

  useEffect(() => {
    if (!session || session.status !== 'pending') return
    const ticker = setInterval(() => setPendingTick((x) => x + 1), 1000)
    return () => clearInterval(ticker)
  }, [session])

  const loadRequests = async () => {
    const res = await Api.mcp.requests(50)
    if (res.ok) setRequests(res.rows)
  }

  const loadDiag = async () => {
    const res = await Api.mcp.diagnose()
    if (res.ok) setDiag(res.diag)
  }

  const loadMachines = async () => {
    const res = await Api.mcp.machines()
    if (res.ok) setMachines(res.machines)
  }

  const loadAgents = async () => {
    const res = await Api.agent.statuses()
    if (res.ok) setAgents(res.agents)
  }

  const loadAgentTokens = async () => {
    const res = await Api.agent.tokens()
    if (res.ok) setAgentTokens(res.tokens)
  }

  const playBeep = () => {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = 880
      osc.type = 'sine'
      gain.gain.value = 0.08
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      setTimeout(() => {
        osc.stop()
        void ctx.close()
      }, 140)
    } catch {
      // ignore
    }
  }

  const loadSession = async () => {
    const res = await Api.agent.sessions()
    if (res.ok) {
      setSessionHistory(res.sessions)
      const active = res.sessions.find((s) => s.status === 'pending' || s.status === 'active')
      setSession(active ?? null)
      const pending = res.sessions.filter((s) => s.status === 'pending').length
      if (pending > pendingRef.current) playBeep()
      pendingRef.current = pending
    }
  }

  const refresh = async () => {
    try {
      const status = await Api.mcp.status()
      setMcp(status)
      setLanLocal(status.lan)
      if (status.port) setPort(String(status.port))
      await Promise.all([loadRequests(), loadDiag(), loadMachines(), loadAgents(), loadAgentTokens(), loadSession()])
    } catch {
      setError('Actualisation impossible (serveur MCP injoignable ?).')
    }
  }

  useEffect(() => {
    void refresh()
    // Les sessions distantes arrivent d'un appareil externe : sans cet
    // auto-refresh, une demande « en attente » n'apparaît que si l'utilisateur
    // clique sur « Actualiser ». 10 s fait aussi défiler le compte à rebours.
    const timer = setInterval(() => void refresh(), 10_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // Un refus de permission (navigateur/OS) rejetterait silencieusement
      // alors que l'utilisateur croit avoir copié.
      setError('Copie dans le presse-papier refusée.')
    }
  }

  /**
   * Les jetons ne vivent jamais dans le renderer : c'est le processus principal
   * qui écrit dans le presse-papier, le renderer ne voit qu'un masque.
   */
  const copySecret = async (kind: SecretCopyKind, id: string | undefined, key: string): Promise<void> => {
    const r = await Api.secret.copy(kind, id)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const setEnabled = (enabled: boolean, lan = lanLocal) =>
    run(async () => {
      if (enabled && lan && !window.confirm('Exposer le serveur MCP sur le réseau local (LAN) ?\n\nTous les appareils du réseau pourront se connecter avec un jeton valide. Chaque appareil a un jeton dédié.')) {
        return
      }
      const res = await Api.mcp.setEnabled(enabled, { lan })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setMcp(res.status)
      setLanLocal(res.status.lan)
      setPort(String(res.status.port ?? port))
      await loadRequests()
    })

  const toggleLan = () => {
    if (!mcp) return
    void setEnabled(mcp.enabled, !lanLocal)
  }

  const applyPort = () => {
    if (!mcp?.enabled) return
    void run(async () => {
      const res = await Api.mcp.setEnabled(true, { port: Number(port) || null, lan: lanLocal })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setMcp(res.status)
    })
  }

  const regenerate = () =>
    run(async () => {
      const res = await Api.mcp.regenerateToken()
      if (!res.ok) {
        setError(res.error)
        return
      }
      setMcp(res.status)
    })

  const fixFirewall = () =>
    run(async () => {
      const res = await Api.mcp.firewallFix()
      if (!res.ok) {
        setError(res.error)
        return
      }
      await loadDiag()
    })

  const addToken = () =>
    run(async () => {
      const res = await Api.mcp.addToken(newLabel.trim())
      if (!res.ok) {
        setError(res.error)
        return
      }
      setNewLabel('')
      setMcp(res.status)
    })

  const revoke = (id: string, label: string) =>
    run(async () => {
      if (!mcp || mcp.tokens.length <= 1) {
        setError('Au moins un jeton doit rester actif.')
        return
      }
      if (!window.confirm(`Révoquer le jeton « ${label} » ? L'IA de ce poste ne pourra plus se connecter.`)) return
      const res = await Api.mcp.revokeToken(id)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setMcp(res.status)
    })

  const baseUrl = (host: string) => `http://${host}:${mcp?.port ?? '8787'}/mcp`

  const agentWsUrl = (host: string) => `ws://${host}:${mcp?.port ?? '8787'}/agent`

  const connectAgent = (tokenId: string) =>
    run(async () => {
      const res = await Api.agent.sessionRequest(tokenId)
      if (!res.ok) {
        setError(res.error)
        return
      }
      await loadSession()
      if (!res.session) {
        setError("L'agent de cette machine est hors ligne ou occupe déjà une session.")
        return
      }
    })

  const decide = (approve: boolean) =>
    run(async () => {
      if (!session) return
      const res = await Api.agent.sessionDecide(session.id, approve)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setSession(null)
      await Promise.all([loadAgents(), loadSession()])
    })

  const addAgentToken = () =>
    run(async () => {
      const res = await Api.agent.addToken(agentNewLabel.trim())
      if (!res.ok) {
        setError(res.error)
        return
      }
      setAgentNewLabel('')
      await loadAgentTokens()
      await copySecret('agentToken', res.id, `agent-${res.masked}`)
    })

  const revokeAgentToken = (id: string, label: string) =>
    run(async () => {
      if (!window.confirm(`Révoquer l'accès de « ${label} » ? L'agent de cette machine sera déconnecté et ne pourra plus demander de session.`)) return
      const res = await Api.agent.revokeToken(id)
      if (!res.ok) {
        setError(res.error)
        return
      }
      await Promise.all([loadAgentTokens(), loadAgents()])
    })

  const timeoutLabel = (s: RemoteSessionInfo) => {
    const elapsed = Date.now() - s.requestedAt
    return elapsed > 120000
      ? { color: '#ef4444' }
      : elapsed > 60000
        ? { color: '#f59e0b' }
        : { color: '#34d399' }
  }

  // Extrait affiche sans le jeton : le bouton « Copier la config » demande au
  // processus principal de copier la version complete.
  const configSnippet = () => {
    const host = mcp?.lan && mcp.hosts.length > 0 ? mcp.hosts[0]! : '127.0.0.1'
    return `{
  "bountydesk": {
    "type": "remote",
    "url": "${baseUrl(host)}",
    "headers": {
      "Authorization": "Bearer <JETON>",
      "Content-Type": "application/json"
    }
  }
}`
  }

  return (
    <div className="section">
      <div className="section-header">
        <h2>Réglages</h2>
      </div>

      <div className="box">
        <h3>Assistant IA (protocole MCP)</h3>
        <p className="muted-text">
          Expose Venari à des IA (Claude Desktop, opencode, Cursor…) via un serveur MCP. Chaque poste/IA a son jeton
          dédié. L'IA peut lister les programmes, lire le scope et les ROE, installer les outils et lancer des scans
          low/med/high (toujours filtrés in-scope + confirmation ROE). <strong>Jamais de soumission de rapport
          automatique.</strong>
        </p>

        {error && <div className="banner-error">{error}</div>}

        {mcp && (
          <div className="mcp-box">
            <div className="mcp-row">
              <label>
                <input type="checkbox" checked={mcp.enabled} onChange={() => void setEnabled(!mcp.enabled)} disabled={busy} />{' '}
                Activer le serveur MCP
              </label>
              <span className={mcp.enabled ? 'mcp-dot on' : 'mcp-dot'}>
                {mcp.running ? `Actif — port ${mcp.port ?? '?'}` : 'Arrêté'}
              </span>
            </div>

            {mcp.enabled && (
              <>
                <div className="mcp-row">
                  <label>
                    Port{' '}
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      style={{ width: 90 }}
                    />
                    <button className="btn ghost small" disabled={busy} onClick={() => void applyPort()}>
                      Appliquer
                    </button>
                  </label>
                </div>

                <div className="mcp-row">
                  <label>Adresse du serveur MCP</label>
                  <div className="mcp-token">
                    <code>{baseUrl('127.0.0.1')}</code>
                    <button
                      className="btn ghost small"
                      onClick={() => void copy(baseUrl('127.0.0.1'), 'url-local')}
                    >
                      {copied === 'url-local' ? 'Copié ✓' : 'Copier l’URL'}
                    </button>
                  </div>
                </div>

                {lanLocal && mcp.hosts.length > 0 && (
                  <div className="mcp-row">
                    <label>Adresses LAN (autres PC)</label>
                    <div className="mcp-token">
                      {mcp.hosts.map((h) => (
                        <span key={h} className="mcp-chip">
                          <code>{baseUrl(h)}</code>
                          <button
                            className="btn ghost small"
                            onClick={() => void copy(baseUrl(h), `url-${h}`)}
                          >
                            {copied === `url-${h}` ? 'Copié ✓' : 'Copier'}
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mcp-row">
                  <label>
                    <input type="checkbox" checked={lanLocal} onChange={() => void toggleLan()} disabled={busy} />{' '}
                    Exposer sur le réseau local (LAN)
                  </label>
                  {lanLocal && mcp.hosts.length > 0 && (
                    <div className="mcp-token">
                      {mcp.hosts.map((h) => (
                        <button
                          key={h}
                          className="btn ghost small"
                          onClick={() => void copy(baseUrl(h), `url-${h}`)}
                        >
                          {h} · copier
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mcp-box">
                  <h4>Santé du serveur</h4>
                  {diag && (
                    <>
                      <div className="mcp-row">
                        <span className={diag.running ? 'mcp-dot on' : 'mcp-dot'}>
                          {diag.running
                            ? `En écoute — ${diag.lan ? 'toutes interfaces (0.0.0.0)' : 'localhost (127.0.0.1)'}${diag.port ? `, port ${diag.port}` : ''}`
                            : 'Serveur arrêté'}
                        </span>
                      </div>
                      <div className="mcp-row">
                        <span>Pare-feu&nbsp;:&nbsp;</span>
                        {diag.firewall === 'ok' && <span className="mcp-status-ok">règle « Venari MCP » présente</span>}
                        {diag.firewall === 'missing' && (
                          <>
                            <span className="mcp-status-err">règle absente — le LAN peut être bloqué</span>
                            <button className="btn primary small" disabled={busy} onClick={() => void fixFirewall()}>
                              Réparer (demande admin)
                            </button>
                          </>
                        )}
                        {diag.firewall === 'unmanaged' && <span className="muted-text">pare-feu non géré (OS non Windows)</span>}
                      </div>
                      <div className="mcp-row">
                        <span>Auto-test local&nbsp;:&nbsp;</span>
                        {diag.selfTest ? (
                          diag.selfTest.ok ? (
                            <span className="mcp-status-ok">HTTP 200 — {diag.selfTest.ms} ms</span>
                          ) : (
                            <span className="mcp-status-err">échec — {diag.selfTest.error}</span>
                          )
                        ) : (
                          <span className="muted-text">indisponible (serveur arrêté)</span>
                        )}
                      </div>
                      {diag.recentErrors.length > 0 && (
                        <div className="mcp-row">
                          <span>
                            <span className="mcp-status-err">{diag.recentErrors.length} erreur(s) récente(s)</span>
                          </span>
                        </div>
                      )}
                      <button className="btn ghost small" disabled={busy} onClick={() => void loadDiag()}>
                        Diagnostiquer
                      </button>
                    </>
                  )}
                </div>

                <div className="mcp-box">
                  <h4>Machines connectées ({machines.length})</h4>
                  <p className="muted-text">
                    Postes qui ont appelé ce serveur MCP, groupés par jeton.
                  </p>
                  {machines.length === 0 ? (
                    <p className="muted-text">Aucune machine pour l'instant.</p>
                  ) : (
                    <table className="mcp-table">
                      <thead>
                        <tr>
                          <th>Poste</th>
                          <th>Dernière activité</th>
                          <th>Appels</th>
                          <th>Erreurs</th>
                          <th>Adresses</th>
                        </tr>
                      </thead>
                      <tbody>
                        {machines.map((m) => (
                          <tr key={m.tokenLabel}>
                            <td>{m.tokenLabel}</td>
                            <td>{new Date(m.lastSeen).toLocaleString('fr-FR')}</td>
                            <td>{m.calls}</td>
                            <td className={m.errors > 0 ? 'mcp-status-err' : 'mcp-status-ok'}>{m.errors}</td>
                            <td>{m.ips.join(', ') || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <button className="btn ghost small" disabled={busy} onClick={() => void loadMachines()}>
                    Actualiser
                  </button>
                </div>

                <div className="mcp-box">
                  <h4>Machines à distance (vision)</h4>
                  <p className="muted-text">
                    Les postes qui exécutent l'agent Venari peuvent demander à vous montrer leur écran. Chaque
                    demande nécessite votre validation ici, à l'écran.
                  </p>
                  {session && (
                    <div className="mcp-row" style={{ border: '1px solid #262d39', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                      <div style={{ flex: 1 }}>
                        <strong>Session {session.status === 'pending' ? 'en attente' : 'active'}</strong>
                        <div className="muted-text">
                          {session.agentLabel || 'Machine distante'} · {session.remoteIp || '—'} ·
                          {session.status === 'pending' ? (
                            <span style={timeoutLabel(session)}>
                              {' '}
                              demandée il y a {Math.max(0, Math.round((Date.now() - session.requestedAt) / 1000))} s
                            </span>
                          ) : (
                            <> ouverte</>
                          )}
                        </div>
                      </div>
                      {session.status === 'pending' && (
                        <div className="cred-actions">
                          <button className="btn primary small" disabled={busy} onClick={() => void decide(true)}>
                            Autoriser
                          </button>
                          <button className="btn danger small" disabled={busy} onClick={() => void decide(false)}>
                            Refuser
                          </button>
                        </div>
                      )}
                      {session.status === 'active' && (
                        <button className="btn ghost small" disabled={busy} onClick={() => void decide(false)}>
                          Terminer
                        </button>
                      )}
                    </div>
                  )}
                  {agents.length === 0 ? (
                    <p className="muted-text">Aucun jeton d'agent configuré.</p>
                  ) : (
                    <table className="mcp-table">
                      <thead>
                        <tr>
                          <th>Machine</th>
                          <th>Adresse</th>
                          <th>Statut</th>
                          <th>Latence</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agents.map((a) => (
                          <tr key={a.id}>
                            <td>{a.label}</td>
                            <td>{a.ip || a.hostname || '—'}</td>
                            <td>
                              <span className={a.online ? 'mcp-dot on' : 'mcp-dot'}>
                                {a.streaming ? 'en session' : a.online ? 'en ligne' : 'hors ligne'}
                              </span>
                            </td>
                            <td>{a.latency != null ? `${a.latency} ms` : '—'}</td>
                            <td>
                              <button
                                className="btn primary small"
                                disabled={busy || !a.online || a.streaming}
                                onClick={() => void connectAgent(a.id)}
                              >
                                {a.streaming ? 'Session active' : a.online ? 'Se connecter' : 'Hors ligne'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <details>
                    <summary style={{ marginTop: 8 }}>Jetons d'agent (config de l'agent)</summary>
                    {agentTokens.map((t) => (
                      <div className="cred-row" key={t.id}>
                        <div className="cred-main">
                          <span className="cred-label">{t.label}</span>
                          <code className="mcp-token-value">{t.masked}</code>
                        </div>
                        <div className="cred-actions">
                          <button className="icon-btn" title="Copier le jeton" onClick={() => void copySecret('agentToken', t.id, `agtok-${t.id}`)}>
                            {copied === `agtok-${t.id}` ? '✓' : '⧉'}
                          </button>
                          <button className="icon-btn danger" title="Révoquer" onClick={() => void revokeAgentToken(t.id, t.label)}>
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                    <div className="mcp-row">
                      <input
                        type="text"
                        placeholder="Nom de la machine (ex : Boite)"
                        value={agentNewLabel}
                        maxLength={60}
                        onChange={(e) => setAgentNewLabel(e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button className="btn primary small" disabled={busy || !agentNewLabel.trim()} onClick={() => void addAgentToken()}>
                        + Jeton d'agent
                      </button>
                    </div>
                    <p className="muted-text">
                      Copiez le jeton et créez un <code>config.json</code> à côté de l'exe agent :
                    </p>
                    <pre>{`{\n  "server": "${mcp?.lan && mcp.hosts.length > 0 ? mcp.hosts[0]! : '127.0.0.1'}",\n  "port": ${mcp?.port ?? 8787},\n  "token": "<JETON>"\n}`}</pre>
                    <div className="mcp-row">
                      <button className="btn ghost small" onClick={() => void copySecret('agentConfig', undefined, 'cfg-agent')}>
                        {copied === 'cfg-agent' ? 'Copié ✓' : 'Copier la config'}
                      </button>
                    </div>
                  </details>
                  <button className="btn ghost small" disabled={busy} onClick={() => void Promise.all([loadAgents(), loadSession()])} style={{ marginTop: 8 }}>
                    Actualiser
                  </button>
                  {sessionHistory.length > 0 && (
                    <details>
                      <summary style={{ marginTop: 8 }}>Historique des sessions ({sessionHistory.length})</summary>
                      <table className="mcp-table">
                        <thead>
                          <tr>
                            <th>Poste</th>
                            <th>Adresse</th>
                            <th>Statut</th>
                            <th>Demandée le</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sessionHistory.slice(0, 20).map((s) => (
                            <tr key={s.id}>
                              <td>{s.agentLabel || 'Machine distante'}</td>
                              <td>{s.remoteIp || '—'}</td>
                              <td>
                                <span className={s.status === 'active' ? 'mcp-dot on' : 'mcp-dot'}>{s.status}</span>
                              </td>
                              <td>{new Date(s.requestedAt).toLocaleTimeString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  )}
                </div>

                <div className="mcp-box">
                  <h4>Jetons (un par PC / IA)</h4>
                  <p className="muted-text">
                    Donnez un jeton au bouton « Copier » à chaque machine qui doit se connecter. Révoquez-le pour couper
                    l'accès immédiatement.
                  </p>
                  {mcp.tokens.map((t) => (
                    <div className="cred-row" key={t.id}>
                      <div className="cred-main">
                        <span className="cred-label">{t.label}</span>
                        <code className="mcp-token-value">{t.masked}</code>
                      </div>
                      <div className="cred-actions">
                        <button className="icon-btn" title="Copier le jeton" onClick={() => void copySecret('mcpToken', t.id, `tok-${t.id}`)}>
                          {copied === `tok-${t.id}` ? '✓' : '⧉'}
                        </button>
                        <button className="icon-btn danger" title="Révoquer le jeton" onClick={() => void revoke(t.id, t.label)}>
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                  {mcp.tokens[0] && (
                    <div className="mcp-row" style={{ marginTop: 8 }}>
                      <button className="btn ghost small" disabled={busy} onClick={() => void regenerate()}>
                        Régénérer le jeton principal
                      </button>
                    </div>
                  )}
                  <div className="mcp-row">
                    <input
                      type="text"
                      placeholder="Nom du poste / IA (ex : PC-bureau, Labo, Philéas)"
                      value={newLabel}
                      maxLength={60}
                      onChange={(e) => setNewLabel(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button className="btn primary small" disabled={busy || !newLabel.trim()} onClick={() => void addToken()}>
                      + Ajouter un jeton
                    </button>
                  </div>
                </div>

                <details className="mcp-config">
                  <summary>Configuration Claude Desktop / opencode</summary>
                  <p className="muted-text">
                    Clé à placer dans <code>claude_desktop_config.json</code> (propriété <code>mcpServers</code>) ou{' '}
                    <code>opencode.json</code> (propriété <code>mcp</code>).
                    {mcp.lan && mcp.hosts.length > 0 && <> Pour un autre PC, remplacez l'URL par <code>{baseUrl(mcp.hosts[0]!)}</code>.</>}
                  </p>
                  <div className="mcp-row">
                    <pre>{configSnippet()}</pre>
                    <button className="btn ghost small" onClick={() => void copySecret('mcpConfig', undefined, 'cfg')}>
                      {copied === 'cfg' ? 'Copié ✓' : 'Copier la config'}
                    </button>
                  </div>
                </details>

                <p className="muted-text">
                  Outils disponibles (18) : <code>list_programs</code> (paginé),{' '}
                  <code>get_program_detail</code>, <code>list_credentials</code> (sans secret),{' '}
                  <code>set_note</code>, <code>list_notes</code>, <code>list_tools</code>,{' '}
                  <code>install_tool</code>, <code>open_browser</code>, <code>fetch_page</code>,{' '}
                  <code>http_request</code>, <code>submit_report</code>,{' '}
                  <code>list_scans</code>, <code>start_scan</code>, <code>get_scan</code>,{' '}
                  <code>scan_events</code>, <code>dedupe_findings</code>, <code>cvss_score</code>,{' '}
                  <code>run_tool</code>.
                </p>

                <div className="mcp-box">
                  <h4>Activité des IA ({requests.length})</h4>
                  <p className="muted-text">
                    Derniers appels MCP reçus, peu importe le poste qui les a envoyés.
                  </p>
                  {requests.length === 0 ? (
                    <p className="muted-text">Aucun appel pour l'instant.</p>
                  ) : (
                    <table className="mcp-table">
                      <thead>
                        <tr>
                          <th>Heure</th>
                          <th>Poste</th>
                          <th>Outil</th>
                          <th>Statut</th>
                          <th>Durée</th>
                          <th>Adresse</th>
                        </tr>
                      </thead>
                      <tbody>
                        {requests.map((r) => (
                          <tr key={r.id}>
                            <td>{new Date(r.ts).toLocaleTimeString('fr-FR')}</td>
                            <td>{r.tokenLabel || '—'}</td>
                            <td><code>{r.tool}</code></td>
                            <td className={r.status === 'ok' ? 'mcp-status-ok' : 'mcp-status-err'}>{r.status}</td>
                            <td>{r.ms} ms</td>
                            <td>{r.remoteIp || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <button className="btn ghost small" onClick={() => void loadRequests()} disabled={busy}>
                    Actualiser
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <button className="btn danger" onClick={onLogout}>
          Se déconnecter
        </button>
      </div>
    </div>
  )
}