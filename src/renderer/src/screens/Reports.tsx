import { useCallback, useEffect, useMemo, useState } from 'react'
import { Api } from '../api'
import type { ReportFile } from '../../../shared/ipc'

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

export function ReportsScreen() {
  const [reports, setReports] = useState<ReportFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [tick, setTick] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await Api.reports.list()
      if (r.ok) {
        setReports(r.reports)
        setError(null)
      } else {
        setError(r.error)
      }
    } catch (e) {
      setError(`Impossible de charger les rapports : ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, tick])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return reports
    return reports.filter((r) => r.name.toLowerCase().includes(q) || r.programId.toLowerCase().includes(q))
  }, [reports, search])

  const open = async (report: ReportFile): Promise<void> => {
    try {
      const r = await Api.reports.openFolder(report.path)
      if (!r.ok) setError(`Ouverture impossible : ${r.error ?? 'erreur inconnue'}`)
    } catch (e) {
      setError(`Ouverture impossible : ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const reveal = async (report: ReportFile): Promise<void> => {
    try {
      const r = await Api.reports.openFolder(report.path)
      if (!r.ok) setError(`Dossier introuvable : ${r.error ?? 'erreur inconnue'}`)
    } catch (e) {
      setError(`Dossier introuvable : ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="section">
      <div className="section-header">
        <h2>Rapports</h2>
        <p className="muted">
          Rapports Markdown ecrits par l’IA (<code>submit_report</code>) et ranges par programme. Rien n’est
          soumis automatiquement : l’envoi a la plateforme reste manuel.
        </p>
      </div>

      <div className="box scans-toolbar">
        <input
          className="search"
          type="search"
          placeholder="Filtrer par fichier ou programme…"
          aria-label="Rechercher un rapport"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="muted" aria-live="polite">
          {loading ? 'Chargement…' : `${filtered.length} / ${reports.length} rapport${reports.length > 1 ? 's' : ''}`}
        </span>
        <button className="btn small" onClick={() => setTick((n) => n + 1)} disabled={loading}>
          Rafraîchir
        </button>
      </div>

      {error && (
        <div className="banner-error" role="alert">
          {error}
          <button className="modal-close" onClick={() => setError(null)} aria-label="Fermer">
            ×
          </button>
        </div>
      )}

      {!loading && reports.length === 0 && !error && (
        <div className="empty-state">
          <p>
            Aucun rapport pour l’instant. Ils apparaissent ici des qu’une IA appelle <code>submit_report</code>.
          </p>
        </div>
      )}

      {!loading && reports.length > 0 && filtered.length === 0 && (
        <div className="empty-state">
          <p>Aucun rapport ne correspond au filtre.</p>
        </div>
      )}

      {filtered.length > 0 && (
        <table className="mcp-table scans-table">
          <thead>
            <tr>
              <th>Rapport</th>
              <th>Programme</th>
              <th>Modifié</th>
              <th>Taille</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.path}>
                <td>
                  <strong>{r.name}</strong>
                </td>
                <td>
                  <code>{r.programId}</code>
                </td>
                <td>{new Date(r.updatedAt).toLocaleString('fr-FR')}</td>
                <td>{fmtSize(r.size)}</td>
                <td className="report-actions">
                  <button className="btn small" onClick={() => void open(r)}>
                    Ouvrir
                  </button>
                  <button className="btn small" onClick={() => void reveal(r)}>
                    Dossier
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
