import React from 'react'
import { Api } from '../api'
import type { McpStatusInfo } from '../../../shared/ipc'

export function McpScreen() {
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [mcp, setMcp] = React.useState<McpStatusInfo | null>(null)
  // null = pas encore chargé : sans ce drapeau, l'état « indisponible »
  // s'affiche pendant le premier aller-retour IPC.
  const [mcpLoaded, setMcpLoaded] = React.useState(false)

  React.useEffect(() => {
    void Api.mcp.status()
      .then(setMcp)
      .catch(() => setMcp(null))
      .finally(() => setMcpLoaded(true))
  }, [])

  const openBrowser = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await Api.shell.openBrowser()
      if (!res.ok) setError(res.error ?? 'Ouverture impossible')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="section">
      <div className="section-header">
        <h2>Assistant</h2>
      </div>
      <div className="box">
        <button type="button" className="btn" disabled={busy} onClick={() => void openBrowser()}>
          Ouvrir le navigateur intégré
        </button>
        {error ? <p className="muted-text">{error}</p> : null}
        <p className="muted">
          Une seule fenêtre au lieu d’empiler les onglets : l’IA y consulte la documentation, les scopes et
          les advisories. Le site distant est chargé dans une iframe sandboxée, sans accès au pont privilégié
          de l’application, et les pop-ups sont bloqués.
        </p>
      </div>
      <div className="box">
        <p className="muted">
          {!mcpLoaded
            ? 'Chargement de l’état du serveur MCP…'
            : mcp === null
              ? 'État du serveur MCP indisponible.'
              : !mcp.enabled
              ? 'Serveur MCP désactivé — activez-le depuis Réglages.'
              : mcp.running
                ? `Serveur MCP actif${mcp.port ? ` sur le port ${mcp.port}` : ''} · ${mcp.tokens.length} jeton(s).`
                : 'Serveur MCP configuré mais à l’arrêt — voyez Réglages.'}
        </p>
        <p className="muted">
          Il expose les 18 outils Venari (programmes, scans, notes, outils) à une IA locale. Port, jetons,
          adresses LAN et journal des appels se gèrent dans Réglages.
        </p>
      </div>
    </div>
  )
}