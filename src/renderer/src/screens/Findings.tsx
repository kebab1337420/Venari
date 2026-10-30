import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  type FindingInput,
  type FindingRecord,
  type FindingSeverity,
  type FindingStatus,
  type ProgramSummary,
  type ReportFile,
} from '../../../shared/ipc'
import { Api } from '../api'
import { Modal } from '../components/Modal'

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  info: 'Info',
  low: 'Basse',
  medium: 'Moyenne',
  high: 'Haute',
  critical: 'Critique',
}

const STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'À qualifier',
  triaged: 'Qualifié',
  reported: 'Rapporté',
  fixed: 'Corrigé',
  duplicate: 'Doublon',
  wontfix: 'Non corrigé',
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

const EMPTY_DRAFT: FindingInput = {
  programId: '',
  asset: '',
  title: '',
  severity: 'medium',
  cvss: null,
  status: 'open',
  description: '',
  poc: '',
  reportPath: null,
  scanId: null,
}

export function FindingsScreen() {
  const [tab, setTab] = useState<'findings' | 'reports'>('findings')
  const [findings, setFindings] = useState<FindingRecord[]>([])
  const [stats, setStats] = useState<Record<string, number>>({})
  const [status, setStatus] = useState<FindingStatus | ''>('')
  const [severity, setSeverity] = useState<FindingSeverity | ''>('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<FindingRecord | 'new' | null>(null)

  const [reports, setReports] = useState<ReportFile[]>([])
  const [reportPath, setReportPath] = useState<string | null>(null)
  const [reportText, setReportText] = useState('')
  const [reportTruncated, setReportTruncated] = useState(false)

  const refreshFindings = useCallback(() => {
    void Api.findings
      .list({ status: status || undefined, severity: severity || undefined, search: search.trim() || undefined })
      .then((r) => {
        if (r.ok) {
          setFindings(r.findings)
          setError(null)
        } else setError(r.error)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    void Api.findings
      .stats()
      .then((r) => {
        if (r.ok) setStats(r.stats)
      })
      .catch(() => undefined)
  }, [status, severity, search])

  useEffect(() => {
    const timer = setTimeout(refreshFindings, search ? 200 : 0)
    return () => clearTimeout(timer)
  }, [refreshFindings, search])

  const refreshReports = useCallback(() => {
    void Api.reports
      .list()
      .then((r) => (r.ok ? setReports(r.reports) : setError(r.error)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    if (tab === 'reports') refreshReports()
  }, [tab, refreshReports])

  const openReport = (entry: ReportFile): void => {
    setReportPath(entry.path)
    setReportText('Chargement…')
    void Api.reports
      .read(entry.path)
      .then((r) => {
        if (r.ok) {
          setReportText(r.content)
          setReportTruncated(r.truncated)
        } else {
          setReportText('')
          setError(r.error)
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  const setStatusOf = (f: FindingRecord, next: FindingStatus): void => {
    // Optimiste : le select doit suivre le clic meme si l'IPC prend 20 ms.
    setFindings((rows) => rows.map((r) => (r.id === f.id ? { ...r, status: next } : r)))
    void Api.findings.update(f.id, { status: next }).then((r) => {
      if (!r.ok) setError(r.error)
      refreshFindings()
    })
  }

  const remove = (f: FindingRecord): void => {
    if (!window.confirm(`Supprimer le finding « ${f.title} » ?`)) return
    setFindings((rows) => rows.filter((r) => r.id !== f.id))
    void Api.findings.remove(f.id).then((r) => {
      if (!r.ok) setError(r.error)
      refreshFindings()
    })
  }

  const counters = useMemo(
    () => [
      { key: 'total', label: 'Total', value: stats.total ?? 0 },
      { key: 'open', label: 'À qualifier', value: stats.open ?? 0 },
      { key: 'reported', label: 'Rapportés', value: stats.reported ?? 0 },
      { key: 'fixed', label: 'Corrigés', value: stats.fixed ?? 0 },
    ],
    [stats],
  )

  return (
    <div className="section">
      <div className="section-header">
        <h2>Findings</h2>
        <div className="toolbar-actions">
          {tab === 'findings' ? (
            <button className="btn primary" onClick={() => setEditing('new')}>
              Nouveau finding
            </button>
          ) : (
            <button className="btn" onClick={() => void Api.reports.openFolder()}>
              Ouvrir le dossier des rapports
            </button>
          )}
        </div>
      </div>

      <div className="toolbar" role="tablist" aria-label="Findings et rapports">
        <button
          className={`chip ${tab === 'findings' ? 'active' : ''}`}
          role="tab"
          aria-selected={tab === 'findings'}
          onClick={() => setTab('findings')}
        >
          Suivi ({stats.total ?? 0})
        </button>
        <button
          className={`chip ${tab === 'reports' ? 'active' : ''}`}
          role="tab"
          aria-selected={tab === 'reports'}
          onClick={() => setTab('reports')}
        >
          Rapports ({reports.length})
        </button>
      </div>

      {error && <div className="banner-error">{error}</div>}

      {tab === 'findings' ? (
        <>
          <div className="finding-counters">
            {counters.map((c) => (
              <div className="box" key={c.key}>
                <span className="detail-label">{c.label}</span>
                <span className="detail-value">{c.value}</span>
              </div>
            ))}
          </div>

          <div className="toolbar">
            <input
              className="search"
              placeholder="Rechercher (titre, cible, description)…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select value={status} onChange={(e) => setStatus(e.target.value as FindingStatus | '')}>
              <option value="">Tous les statuts</option>
              {FINDING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <select value={severity} onChange={(e) => setSeverity(e.target.value as FindingSeverity | '')}>
              <option value="">Toutes les sévérités</option>
              {FINDING_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
          </div>

          {findings.length === 0 ? (
            <div className="empty-state">
              <p>Aucun finding pour ces filtres.</p>
              <p className="muted">
                Les scans et l'IA peuvent en enregistrer via l'outil MCP <code>record_finding</code>, ou créez-en un
                à la main.
              </p>
            </div>
          ) : (
            <div className="finding-table">
              <div className="finding-head">
                <span>Sévérité</span>
                <span>Finding</span>
                <span>Programme</span>
                <span>Statut</span>
                <span>Mis à jour</span>
                <span />
              </div>
              {findings.map((f) => (
                <div className="finding-row" key={f.id}>
                  <span className={`sev sev-${f.severity}`}>
                    {SEVERITY_LABEL[f.severity]}
                    {f.cvss !== null && <small> {f.cvss.toFixed(1)}</small>}
                  </span>
                  <div className="finding-main">
                    <button className="link-btn" onClick={() => setEditing(f)}>
                      {f.title}
                    </button>
                    {f.asset && <code className="muted">{f.asset}</code>}
                  </div>
                  <span className="muted">{f.programName}</span>
                  <select
                    value={f.status}
                    aria-label={`Statut de ${f.title}`}
                    onChange={(e) => setStatusOf(f, e.target.value as FindingStatus)}
                  >
                    {FINDING_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                  <span className="muted">{fmtDate(f.updatedAt)}</span>
                  <div className="finding-actions">
                    {f.reportPath && (
                      <button
                        className="icon-btn"
                        title="Voir le rapport"
                        onClick={() => {
                          setTab('reports')
                          setTimeout(refreshReports, 0)
                          openReport({
                            programId: f.programId,
                            path: f.reportPath!,
                            name: f.reportPath!.split('/').pop() ?? '',
                            size: 0,
                            updatedAt: f.updatedAt,
                          })
                        }}
                      >
                        ↗
                      </button>
                    )}
                    <button className="icon-btn danger" title="Supprimer" onClick={() => remove(f)}>
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="reports-layout">
          <div className="reports-list">
            {reports.length === 0 ? (
              <p className="muted">
                Aucun rapport. Ils sont écrits par l'outil MCP <code>submit_report</code> dans le dossier de données
                de Venari.
              </p>
            ) : (
              reports.map((r) => (
                <button
                  key={r.path}
                  className={`report-item ${reportPath === r.path ? 'active' : ''}`}
                  onClick={() => openReport(r)}
                >
                  <span className="report-name">{r.name}</span>
                  <span className="muted">
                    {r.programId} · {fmtSize(r.size)} · {fmtDate(r.updatedAt)}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="report-view">
            {reportPath ? (
              <>
                <div className="toolbar-actions">
                  <button className="btn small" onClick={() => void Api.reports.openFolder(reportPath)}>
                    Voir dans le dossier
                  </button>
                </div>
                {reportTruncated && <p className="muted">Aperçu tronqué à 512 Ko.</p>}
                <pre className="report-text">{reportText}</pre>
              </>
            ) : (
              <p className="muted">Sélectionnez un rapport pour l'afficher.</p>
            )}
          </div>
        </div>
      )}

      {editing && (
        <FindingForm
          finding={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refreshFindings()
            if (tab === 'reports') refreshReports()
          }}
        />
      )}
    </div>
  )
}

function FindingForm(props: { finding: FindingRecord | null; onClose: () => void; onSaved: () => void }) {
  const { finding } = props
  const [draft, setDraft] = useState<FindingInput>(
    finding
      ? {
          programId: finding.programId,
          asset: finding.asset,
          title: finding.title,
          severity: finding.severity,
          cvss: finding.cvss,
          status: finding.status,
          description: finding.description,
          poc: finding.poc,
          reportPath: finding.reportPath,
          scanId: finding.scanId,
        }
      : EMPTY_DRAFT,
  )
  const [programQuery, setProgramQuery] = useState(finding ? `${finding.programName} (${finding.programId})` : '')
  const [programs, setPrograms] = useState<ProgramSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (finding || draft.programId || programQuery.trim().length < 2) {
      setPrograms([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      void Api.programs.list({ search: programQuery.trim(), limit: 8 }).then((page) => {
        if (alive) setPrograms(page.records)
      })
    }, 200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [programQuery, draft.programId, finding])

  const pick = (p: ProgramSummary): void => {
    setDraft((d) => ({ ...d, programId: p.id }))
    setProgramQuery(`${p.name} (${p.handle})`)
    setPrograms([])
  }

  const save = (): void => {
    setError(null)
    if (!draft.programId) {
      setError('Choisissez un programme.')
      return
    }
    if (!draft.title.trim()) {
      setError('Le titre est requis.')
      return
    }
    setBusy(true)
    const done = (r: { ok: boolean; error?: string }): void => {
      setBusy(false)
      if (r.ok) props.onSaved()
      else setError(r.error ?? 'Échec de l’enregistrement')
    }
    const payload: FindingInput = {
      ...draft,
      title: draft.title.trim(),
      asset: draft.asset.trim(),
    }
    if (finding) {
      void Api.findings.update(finding.id, payload).then(done).catch((e) => done({ ok: false, error: String(e) }))
    } else {
      void Api.findings
        .create(payload)
        .then((r) => done(r.ok ? { ok: true } : { ok: false, error: r.error }))
        .catch((e) => done({ ok: false, error: String(e) }))
    }
  }

  const set = <K extends keyof FindingInput>(key: K, value: FindingInput[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }))

  return (
    <Modal title={finding ? 'Modifier le finding' : 'Nouveau finding'} onClose={props.onClose} wide>
      {error && <div className="banner-error">{error}</div>}
      <div className="form-grid">
        <label className="field span-2">
          <span>Programme</span>
          <input
            value={programQuery}
            placeholder="Rechercher un programme…"
            disabled={!!finding}
            onChange={(e) => setProgramQuery(e.target.value)}
          />
          {programs.length > 0 && (
            <div className="program-suggest">
              {programs.map((p) => (
                <button key={p.id} className="program-suggest-item" onClick={() => pick(p)}>
                  <span>{p.name}</span>
                  <span className="muted">{p.handle}</span>
                </button>
              ))}
            </div>
          )}
        </label>
        <label className="field span-2">
          <span>Titre</span>
          <input value={draft.title} maxLength={300} onChange={(e) => set('title', e.target.value)} />
        </label>
        <label className="field span-2">
          <span>Cible (URL, endpoint)</span>
          <input value={draft.asset} maxLength={500} onChange={(e) => set('asset', e.target.value)} />
        </label>
        <label className="field">
          <span>Sévérité</span>
          <select value={draft.severity} onChange={(e) => set('severity', e.target.value as FindingSeverity)}>
            {FINDING_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>CVSS (0–10, optionnel)</span>
          <input
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={draft.cvss ?? ''}
            onChange={(e) => set('cvss', e.target.value === '' ? null : Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Statut</span>
          <select value={draft.status} onChange={(e) => set('status', e.target.value as FindingStatus)}>
            {FINDING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Scan lié (optionnel)</span>
          <input
            type="number"
            min={1}
            value={draft.scanId ?? ''}
            onChange={(e) => set('scanId', e.target.value === '' ? null : Number(e.target.value))}
          />
        </label>
        <label className="field span-2">
          <span>Description</span>
          <textarea rows={4} value={draft.description} onChange={(e) => set('description', e.target.value)} />
        </label>
        <label className="field span-2">
          <span>Preuve (PoC)</span>
          <textarea rows={3} value={draft.poc} onChange={(e) => set('poc', e.target.value)} />
        </label>
      </div>
      <div className="modal-footer" style={{ padding: '12px 0 0' }}>
        <button className="btn" onClick={props.onClose}>
          Annuler
        </button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </Modal>
  )
}
