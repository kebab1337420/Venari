import { useCallback, useEffect, useState } from 'react'
import { Api } from '../api'
import type { ScanOverview } from '../../../shared/ipc'
import { ScanProgressModal } from '../components/ScanModals'

const STATUS: Record<string, { label: string; cls: string }> = {
  running: { label: 'en cours', cls: 'running' },
  done: { label: 'terminé', cls: 'done' },
  error: { label: 'erreur', cls: 'error' },
  stopped: { label: 'arrêté', cls: 'stopped' }
}

const DEPTH_LABEL: Record<string, string> = { low: 'Bas', med: 'Moyen', high: 'Élevé' }

function fmtDuration(scan: ScanOverview): string {
  const end = scan.finishedAt ?? Date.now()
  const total = Math.max(0, Math.round((end - scan.startedAt) / 1000))
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} min ${total % 60} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export function ScansScreen() {
  const [scans, setScans] = useState<ScanOverview[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ScanOverview | null>(null)
  const [tick, setTick] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await Api.scans.listAll(200)
      if (r.ok) {
        setScans(r.scans)
        setError(null)
      } else {
        setError(r.error)
      }
    } catch (e) {
      setError(`Impossible de charger les scans : ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, tick])

  // Tant qu'un scan tourne, la liste se rafraichit pour voir la fin arriver
  // sans avoir a rouvrir la fiche du programme.
  const running = scans.filter((s) => s.status === 'running').length
  useEffect(() => {
    if (running === 0) return
    const timer = setInterval(() => setTick((n) => n + 1), 3000)
    return () => clearInterval(timer)
  }, [running])

  const closeLog = (): void => {
    setSelected(null)
    setTick((n) => n + 1)
  }

  return (
    <div className="section">
      <div className="section-header">
        <h2>Scans</h2>
        <p className="muted">
          Suivi global des scans : une fiche fermée ne fait plus perdre la trace d’un scan en cours.
        </p>
      </div>

      <div className="box scans-toolbar">
        <span className="muted" aria-live="polite">
          {loading
            ? 'Chargement…'
            : running > 0
              ? `${running} scan${running > 1 ? 's' : ''} en cours`
              : `${scans.length} scan${scans.length > 1 ? 's' : ''}`}
        </span>
        <button className="btn small" onClick={() => setTick((n) => n + 1)} disabled={loading}>
          Rafraîchir
        </button>
        {scans.some((s) => s.status !== 'running') && (
          <button
            className="btn small"
            disabled={loading}
            onClick={async () => {
              const targets = scans.filter((s) => s.status !== 'running')
              if (!confirm(`Supprimer ${targets.length} scan${targets.length > 1 ? 's' : ''} terminé${targets.length > 1 ? 's' : ''} ?`)) return
              for (const s of targets) await Api.scans.remove(s.id)
              setTick((n) => n + 1)
            }}
          >
            Nettoyer
          </button>
        )}
      </div>

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      {!loading && scans.length === 0 && !error && (
        <div className="empty-state">
          <p>Aucun scan pour l’instant. Lancez-en depuis la fiche d’un programme.</p>
        </div>
      )}

      {scans.length > 0 && (
        <table className="mcp-table scans-table">
          <thead>
            <tr>
              <th>Programme</th>
              <th>Profondeur</th>
              <th>Statut</th>
              <th>Début</th>
              <th>Durée</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {scans.map((s) => {
              const st = STATUS[s.status] ?? { label: s.status, cls: 'stopped' }
              return (
                <tr key={s.id}>
                  <td>
                    <strong>{s.programName}</strong>
                    {s.programHandle && <span className="muted"> @{s.programHandle}</span>}
                  </td>
                  <td>{DEPTH_LABEL[s.depth] ?? s.depth}</td>
                  <td>
                    <span className={`scan-status ${st.cls}`}>{st.label}</span>
                  </td>
                  <td>{new Date(s.startedAt).toLocaleString('fr-FR')}</td>
                  <td>{fmtDuration(s)}</td>
                  <td>
                    <button className="btn small" onClick={() => setSelected(s)}>
                      {s.status === 'running' ? 'Suivre' : 'Journal'}
                    </button>
                    {s.status !== 'running' && (
                      <button
                        className="btn small danger"
                        onClick={async () => {
                          if (!confirm('Supprimer ce scan et son journal ?')) return
                          const r = await Api.scans.remove(s.id)
                          if (r.ok) setTick((n) => n + 1)
                          else setError(r.error)
                        }}
                        title="Supprimer le scan"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {selected && (
        <ScanProgressModal program={{ name: selected.programName }} scanId={selected.id} onClose={closeLog} />
      )}
    </div>
  )
}
