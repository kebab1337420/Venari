import { useEffect, useState } from 'react'
import type { ProgramDetailData, ProgramSummary } from '../../../shared/ipc'
import { Api } from '../api'
import { Modal } from './Modal'
import { CredentialsModal } from './CredentialsModal'
import { ScanProgressModal, ScanSetupModal } from './ScanModals'

interface Props {
  program: ProgramSummary
  onClose: () => void
}

function fmtMoney(value: number, currency: string): string {
  return `${value.toLocaleString('fr-FR')} ${currency}`
}

export function ProgramDetailModal({ program, onClose }: Props) {
  const [detail, setDetail] = useState<ProgramDetailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCreds, setShowCreds] = useState(false)
  const [showScanSetup, setShowScanSetup] = useState(false)
  const [activeScanId, setActiveScanId] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void Api.programs.detail(program.id)
      .then((r) => {
        if (!alive) return
        if (r.ok) setDetail(r.detail)
        else setError(r.error)
      })
      .catch(() => {
        // Un rejet IPC laisserait sinon la modale bloquee sur « Chargement du
        // detail. » sans aucun moyen de comprendre l'echec.
        if (alive) setError('Détail du programme indisponible.')
      })
    return () => {
      alive = false
    }
  }, [program.id])

  const open = (url: string | null): void => {
    if (url) void Api.shell.openExternal(url)
  }

  const inScopeCount = detail?.scope.filter((d) => d.inScope).length ?? 0
  const changes = detail?.scopeChanges ?? null
  const shownChanges = 5

  return (
    <Modal title={program.name} onClose={onClose} wide>
      {error && <div className="banner-error">{error}</div>}
      {!detail && !error && <p className="muted">Chargement du détail…</p>}

      {detail && changes && (
        <div className="scope-change">
          <strong>Scope modifié depuis la dernière consultation</strong>
          <span className="muted">
            {changes.added.length} ajoutée{changes.added.length > 1 ? 's' : ''}, {changes.removed.length} retirée
            {changes.removed.length > 1 ? 's' : ''}
          </span>
          <ul>
            {changes.added.slice(0, shownChanges).map((c, i) => (
              <li key={`add-${i}`} className="add">
                + <code>{c.endpoint}</code> ({c.inScope ? 'IN' : 'OUT'})
              </li>
            ))}
            {changes.added.length > shownChanges && (
              <li className="muted">+{changes.added.length - shownChanges} autre(s)…</li>
            )}
            {changes.removed.slice(0, shownChanges).map((c, i) => (
              <li key={`rem-${i}`} className="rem">
                − <code>{c.endpoint}</code> ({c.inScope ? 'IN' : 'OUT'})
              </li>
            ))}
            {changes.removed.length > shownChanges && (
              <li className="muted">−{changes.removed.length - shownChanges} autre(s)…</li>
            )}
          </ul>
        </div>
      )}

      {detail && (
        <div className="detail">
          <div className="detail-meta">
            <span className="handle">{program.handle}</span>
            <span className="badge">{detail.status ?? '—'}</span>
            <span className="badge">{detail.type ?? '—'}</span>
            <span className="badge">{detail.confidentiality ?? '—'}</span>
            {detail.industry && <span className="muted">{detail.industry}</span>}
          </div>

          <div className="detail-grid">
            <div className="box">
              <span className="detail-label">Prime</span>
              <span className="detail-value">
                {detail.minBounty ? fmtMoney(detail.minBounty.value, detail.minBounty.currency) : '—'} →{' '}
                {detail.maxBounty ? fmtMoney(detail.maxBounty.value, detail.maxBounty.currency) : '—'}
              </span>
            </div>
            <div className="box">
              <span className="detail-label">Scope in-scope</span>
              <span className="detail-value">
                {inScopeCount} / {detail.scope.length} cibles
              </span>
            </div>
            <div className="box">
              <span className="detail-label">ROE</span>
              <span className="detail-value">
                {detail.roe ? (
                  <span className={detail.roe.safeHarbour ? 'ok-dot' : 'plain-dot'}>
                    {detail.roe.safeHarbour ? 'sûr' : 'non renseigné'}
                  </span>
                ) : (
                  'aucune'
                )}
              </span>
            </div>
          </div>

          {detail.webLink && (
            <button className="btn small" onClick={() => open(detail.webLink)}>
              Ouvrir la page du programme
            </button>
          )}

          <div className="detail-actions">
            <button className="btn primary" onClick={() => setShowCreds(true)}>
              Get credentials
            </button>
            <button className="btn" onClick={() => setShowScanSetup(true)}>
              ⚡ Scanner (low / med / high)
            </button>
          </div>

          {detail.roe && detail.roe.description && (
            <section>
              <h4>Règles d’engagement</h4>
              <p className="detail-desc">{detail.roe.description}</p>
              <div className="roe-flags">
                <span className={`roe-flag ${detail.roe.intigritiMe ? 'yes' : 'no'}`}>
                  IntigritiMe {detail.roe.intigritiMe ? '✓' : '✕'}
                </span>
                <span className="roe-flag">
                  Outils auto : {detail.roe.automatedTooling ?? 'non précisé'}
                </span>
                {detail.roe.userAgent && (
                  <span className="roe-flag" title="User-Agent exigé">
                    UA : <code>{detail.roe.userAgent}</code>
                  </span>
                )}
                {detail.roe.requestHeader && (
                  <span className="roe-flag" title="Header exigé">
                    Header : <code>{detail.roe.requestHeader}</code>
                  </span>
                )}
              </div>
              {detail.roe.attachments.length > 0 && (
                <div className="roe-attachments">
                  {detail.roe.attachments.map((a, i) => (
                    <button key={i} className="btn small" onClick={() => open(a.url)}>
                      Pièce jointe ({a.code})
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          <section>
            <h4>Scope ({detail.scope.length})</h4>
            <div className="scope-list">
              {detail.scope.map((d) => (
                <div key={d.id} className={`scope-row ${d.inScope ? 'in' : 'out'}`}>
                  <span className={`scope-badge ${d.inScope ? 'in' : 'out'}`}>
                    {d.inScope ? 'IN' : 'OUT'}
                  </span>
                  <div className="scope-main">
                    <code className="scope-endpoint">{d.endpoint}</code>
                    {d.description && <span className="muted">{d.description}</span>}
                  </div>
                  <span className="scope-tier">{d.tier}</span>
                </div>
              ))}
              {detail.scope.length === 0 && <p className="muted">Aucun domaine renseigné.</p>}
            </div>
          </section>
        </div>
      )}

      {showCreds && <CredentialsModal program={program} onClose={() => setShowCreds(false)} />}

      {showScanSetup && detail && (
        <ScanSetupModal
          program={program}
          detail={detail}
          onClose={() => setShowScanSetup(false)}
          onStarted={(scanId) => {
            setShowScanSetup(false)
            setActiveScanId(scanId)
          }}
          onViewLog={(scanId) => {
            setShowScanSetup(false)
            setActiveScanId(scanId)
          }}
        />
      )}

      {activeScanId !== null && (
        <ScanProgressModal program={program} scanId={activeScanId} onClose={() => setActiveScanId(null)} />
      )}
    </Modal>
  )
}