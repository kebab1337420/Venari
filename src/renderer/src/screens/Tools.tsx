import { useEffect, useMemo, useState } from 'react'
import { Api } from '../api'
import type { ToolEntry } from '../../../shared/ipc'

const CATEGORIES: { id: string; label: string }[] = [
  { id: 'recon', label: 'Reconnaissance' },
  { id: 'enumer', label: 'Énumération' },
  { id: 'fuzz', label: 'Fuzzing' },
  { id: 'network', label: 'Réseau' },
  { id: 'utility', label: 'Utilitaire' },
  { id: 'ai', label: 'IA & frameworks de chasse' }
]

interface InstallState {
  status: 'idle' | 'running' | 'ok' | 'error'
  output: string
  error: string
}

export function ToolsScreen() {
  const [tools, setTools] = useState<ToolEntry[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [installState, setInstallState] = useState<Record<string, InstallState>>({})
  const runningIds = useMemo(() => {
    const ids = new Set<string>()
    for (const [id, st] of Object.entries(installState)) if (st.status === 'running') ids.add(id)
    return ids
  }, [installState])
  const installing = runningIds.size > 0

  // La sortie d'installation arrive en continu : elle s'accumule tant que
  // l'outil tourne, puis le résultat final du handler prend le relais. Le
  // tampon est borné — un installateur bavard ne doit pas gonfler l'état du
  // renderer à l'infini.
  useEffect(() => {
    const off = Api.tools.onInstallOutput(({ id, line }) => {
      setInstallState((prev) => {
        const st = prev[id]
        if (!st || st.status !== 'running') return prev
        return { ...prev, [id]: { ...st, output: (st.output + line).slice(-60_000) } }
      })
    })
    return off
  }, [])
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [onlyInstalled, setOnlyInstalled] = useState(false)
  const [ghToken, setGhToken] = useState('')
  const [ghConfigured, setGhConfigured] = useState(false)
  const [ghMsg, setGhMsg] = useState('')

  const load = async () => {
    setError('')
    // Un rejet IPC laisserait tools à null et l'écran bloqué sur
    // « Vérification… » : on remonte l'erreur et on rend une liste vide.
    try {
      const res = await Api.tools.list()
      if (res.ok) {
        setTools(res.tools)
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.size === 0) {
            for (const t of res.tools) if (t.defaultChecked) next.add(t.id)
          }
          return next
        })
      } else {
        setError(res.error)
        setTools([])
      }
    } catch (err) {
      setError(`Chargement des outils impossible : ${err instanceof Error ? err.message : String(err)}`)
      setTools([])
    }
    try {
      const ghs = await Api.tools.githubTokenStatus()
      if (ghs.ok) setGhConfigured(ghs.configured)
    } catch {
      setGhMsg('Statut du jeton GitHub indisponible.')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const pendingIds = useMemo(() => {
    if (!tools) return []
    return tools
      .filter((t) => selected.has(t.id) && !t.installed)
      .map((t) => t.id)
  }, [tools, selected])

  const allSelected = tools !== null && tools.length > 0 && tools.every((t) => selected.has(t.id))

  const toggleSelectAll = () => {
    if (!tools) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) next.clear()
      else for (const t of tools) next.add(t.id)
      return next
    })
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const installSelection = async () => {
    if (pendingIds.length === 0 || installing) return
    const sourceOf = new Map<string, string>()
    for (const t of tools ?? []) sourceOf.set(t.id, t.source)
    // winget/apt verrouillent leur base : une seule installation système à la
    // fois, sinon elle échoue sur le verrou. Tout le reste (téléchargements
    // GitHub, clonages, venvs uv) mérite le parallélisme — sinon les
    // téléchargements patientent derrière le verrou des gestionnaires.
    const systemLane: string[] = []
    const downloadLane: string[] = []
    for (const id of pendingIds) {
      if (sourceOf.get(id) === 'winget') systemLane.push(id)
      else downloadLane.push(id)
    }

    const runOne = async (id: string): Promise<void> => {
      setInstallState((prev) => ({ ...prev, [id]: { status: 'running', output: '', error: '' } }))
      const res = await Api.tools.install(id)
      setInstallState((prev) => ({
        ...prev,
        [id]:
          res.ok && res.installed
            ? { status: 'ok', output: res.output, error: '' }
            : {
                status: 'error',
                output: res.output,
                error: res.ok ? 'Binaire non détecté après installation.' : res.error
              }
      }))
    }

    const lane = (ids: string[], width: number): Promise<void> => {
      const queue = [...ids]
      const worker = async (): Promise<void> => {
        for (;;) {
          const id = queue.shift()
          if (!id) return
          await runOne(id)
        }
      }
      return Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker)).then(() => undefined)
    }

    await Promise.all([lane(systemLane, 1), lane(downloadLane, 4)])
    await load()
  }

  const byCategory = useMemo(() => {
    const map = new Map<string, ToolEntry[]>()
    if (!tools) return map
    const q = search.trim().toLowerCase()
    const kept = q
      ? tools.filter((t) =>
          [t.id, t.name, t.description, t.category, t.source].join(' ').toLowerCase().includes(q)
        )
      : tools
    const visible = onlyInstalled ? kept.filter((t) => t.installed) : kept
    for (const cat of CATEGORIES) map.set(cat.id, [])
    for (const t of visible) {
      const list = map.get(t.category)
      if (list) list.push(t)
    }
    return map
  }, [tools, search, onlyInstalled])

  const shownCount = useMemo(() => {
    let n = 0
    for (const list of byCategory.values()) n += list.length
    return n
  }, [byCategory])

  return (
    <div className="section">
      <div className="section-header">
        <h2>Outils ⚒</h2>
        <div className="toolbar-actions">
          <button className="btn ghost small" onClick={() => void load()} disabled={installing}>
            Actualiser
          </button>
          <button className="btn ghost small" onClick={toggleSelectAll} disabled={installing}>
            {allSelected ? 'Tout désélectionner' : 'Tout sélectionner'}
          </button>
          <button
            className="btn primary"
            disabled={installing || pendingIds.length === 0}
            onClick={() => void installSelection()}
          >
            {installing
              ? `Installation en cours (${runningIds.size})…`
              : `Installer la sélection (${pendingIds.length})`}
          </button>
        </div>
      </div>
      <p className="muted">
        Outils installés via winget, téléchargés en portable depuis les releases GitHub officielles, ou clonés comme
        framework/wordlist. Cochez puis installez — chaque outil est vérifié (présence du binaire) avant d’être marqué
        installé.
      </p>
      <div className="box" style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="search"
            type="search"
            placeholder="Filtrer par nom, description ou catégorie…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <label style={{ display: 'flex', gap: 5, alignItems: 'center', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={onlyInstalled} onChange={(e) => setOnlyInstalled(e.target.checked)} />
            <span className="muted">installés seulement</span>
          </label>
          <span className="muted" style={{ whiteSpace: 'nowrap' }}>
            {tools ? `${shownCount}/${tools.length}` : '…'}
          </span>
          {(search !== '' || onlyInstalled) && (
            <button
              className="btn ghost small"
              onClick={() => {
                setSearch('')
                setOnlyInstalled(false)
              }}
            >
              Réinitialiser
            </button>
          )}
        </div>
      </div>
      <div className="box" style={{ marginBottom: 10 }}>
        <p className="muted" style={{ margin: '0 0 6px' }}>
          Token GitHub (optionnel) : évite le plafond de 60 requêtes/h de l’API publique qui provoque les erreurs 403.
          Créez-en un sur{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); void Api.shell.openExternal('https://github.com/settings/tokens') }}>
            github.com/settings/tokens
          </a>{' '}
          (aucun scope requis pour lire les releases).
        </p>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="password"
            placeholder={ghConfigured ? 'Token GitHub actuel (gardez vide pour le conserver…' : 'Token GitHub…'}
            value={ghToken}
            maxLength={200}
            onChange={(e) => setGhToken(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <button
            className="btn primary small"
            disabled={busy}
            onClick={async () => {
              const token = ghToken.trim()
              if (!token) return
              setBusy(true)
              setGhMsg('')
              const res = await Api.tools.githubTokenSet(token)
              if (res.ok) {
                setGhConfigured(true)
                setGhToken('')
              } else {
                setGhMsg(res.error)
              }
              setBusy(false)
            }}
          >
            Enregistrer
          </button>
          {ghConfigured && (
            <button
              className="btn ghost small"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setGhMsg('')
                await Api.tools.githubTokenClear()
                setGhConfigured(false)
                setBusy(false)
              }}
            >
              Retirer
            </button>
          )}
          {ghConfigured && <span className="ok">✓ token configuré</span>}
          {ghMsg && <span className="err">{ghMsg}</span>}
        </div>
      </div>
      {error && <div className="banner-error">{error}</div>}

      {!tools ? (
        <div className="box">
          <p className="muted">Vérification des outils installés…</p>
        </div>
      ) : shownCount === 0 ? (
        <div className="box">
          <p className="muted" style={{ margin: 0 }}>
            {error ? 'Liste des outils indisponible (voir ci-dessus).' : 'Aucun outil ne correspond à ce filtre.'}
          </p>
        </div>
      ) : (
        byCategory.size > 0 &&
        CATEGORIES.filter((cat) => (byCategory.get(cat.id)?.length ?? 0) > 0).map((cat) => {
          const items = byCategory.get(cat.id) ?? []
          return (
            <div className="box" key={cat.id}>
              <h4 className="tools-cat">{cat.label}</h4>
              {items.map((tool) => {
                const st = installState[tool.id]
                const running = runningIds.has(tool.id)
                return (
                  <div className="tool-row" key={tool.id}>
                    <label className="tool-main">
                      <input type="checkbox" checked={selected.has(tool.id)} onChange={() => toggle(tool.id)} />
                      <span className="tool-name">{tool.name}</span>
                      <span className="badge">
                        {tool.source === 'winget'
                          ? 'winget'
                          : tool.source === 'git'
                            ? 'framework'
                            : tool.source === 'go'
                              ? 'go install'
                              : tool.source === 'pip'
                                ? 'venv (uv)'
                                : 'portable'}
                      </span>
                      {tool.windowsOnly && <span className="badge warn">Windows</span>}
                      {tool.guiOnly && <span className="badge warn">GUI</span>}
                      {tool.docs && (
                        <button
                          className="btn ghost small"
                          onClick={() => {
                            void Api.shell.openExternal(tool.docs!)
                          }}
                        >
                          Guide
                        </button>
                      )}
                    </label>
                    <span className="tool-desc">{tool.description}</span>
                    <span className="tool-status">
                      {tool.installed ? (
                        <span className="ok">✓ installé</span>
                      ) : running ? (
                        <span className="running">… en cours</span>
                      ) : st?.status === 'error' ? (
                        <span className="err">✕ {st.error}</span>
                      ) : (
                        <span className="muted">non installé</span>
                      )}
                    </span>
                    {st && st.output && (
                      <details className="tool-output">
                        <summary>Sortie</summary>
                        <pre>{st.output.trim() || '(none)'}</pre>
                      </details>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })
      )}
    </div>
  )
}