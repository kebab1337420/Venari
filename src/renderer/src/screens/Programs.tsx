import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ExportFormat, GroupInfo, ProgramSummary, ProgramsQuery, TagInfo } from '../../../shared/ipc'
import { Api } from '../api'
import { Modal } from '../components/Modal'
import { ProgramDetailModal } from '../components/ProgramDetailModal'

const PAGE_SIZE = 200

const STATUS_BUG = /bug/i

function formatBounty(p: ProgramSummary): string {
  const b = p.maxBounty
  if (!b) return '—'
  return `${b.value.toLocaleString('fr-FR')} ${b.currency}`
}

interface RowProps {
  program: ProgramSummary
  groups: GroupInfo[]
  tags: TagInfo[]
  onToggleFavorite: (p: ProgramSummary) => void
  onOpenDetail: (p: ProgramSummary) => void
  onOpenNote: (p: ProgramSummary) => void
  onAddToGroup: (p: ProgramSummary, groupId: number) => void
  onAddTag: (p: ProgramSummary, tagId: number) => void
  onRemoveTag: (p: ProgramSummary, tagName: string) => void
}

/**
 * La ligne est mémoïsée : ouvrir un modal, taper dans une note ou changer de
 * filtre ne repeint pas les ~200 lignes de la page, seules les lignes dont le
 * programme a réellement changé sont recalculées.
 */
const ProgramRow = memo(function ProgramRow({
  program: p,
  groups,
  tags,
  onToggleFavorite,
  onOpenDetail,
  onOpenNote,
  onAddToGroup,
  onAddTag,
  onRemoveTag
}: RowProps) {
  const openFromKeyboard = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Seule la ligne elle-même ouvre le détail : sans ce garde-fou, Entrée ou
    // Espace sur un bouton imbriqué (retrait de tag) déclenchait aussi la
    // navigation, en plus de l'action du bouton.
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpenDetail(p)
    }
  }

  return (
    <li className="program-row">
      <button
        className={`star ${p.favorite ? 'on' : ''}`}
        aria-label={p.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
        aria-pressed={p.favorite}
        onClick={() => onToggleFavorite(p)}
      >
        ★
      </button>
      <div
        className="program-main"
        role="button"
        tabIndex={0}
        aria-label={`Détails de ${p.name}`}
        onClick={() => onOpenDetail(p)}
        onKeyDown={openFromKeyboard}
      >
        <div className="program-title">
          <span className="program-name">{p.name}</span>
          <span className="handle">{p.handle}</span>
        </div>
        <div className="program-meta">
          <span className={`badge ${STATUS_BUG.test(p.status ?? '') ? 'status-bug' : ''}`}>{p.status ?? '—'}</span>
          <span className="badge">{p.type ?? '—'}</span>
          {p.industry && <span className="muted">{p.industry}</span>}
        </div>
        {(p.tags.length > 0 || p.groups.length > 0) && (
          <div className="program-assoc">
            {p.tags.map((t) => (
              <button
                key={t}
                className="tag"
                onClick={(e) => {
                  // Le tag est dans la zone cliquable de la ligne : sans ça,
                  // retirer un tag ouvrait aussi le détail du programme.
                  e.stopPropagation()
                  onRemoveTag(p, t)
                }}
                title="Retirer le tag"
              >
                #{t} ✕
              </button>
            ))}
            {p.groups.map((g) => (
              <span key={g} className="group-tag">
                {g}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="program-actions">
        <button className="btn small" title="Détails de la mission" onClick={() => onOpenDetail(p)}>
          Détails
        </button>
        <span className={`bounty ${p.maxBounty ? '' : 'none'}`} title="Prime max">
          {formatBounty(p)}
        </span>
        <select
          aria-label={`Ajouter ${p.name} à un groupe`}
          value=""
          onChange={(e) => {
            const gid = Number(e.target.value)
            if (gid) onAddToGroup(p, gid)
          }}
        >
          <option value="">+ groupe</option>
          {groups
            .filter((g) => !p.groups.includes(g.name))
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </select>
        <select
          aria-label={`Ajouter un tag à ${p.name}`}
          value=""
          onChange={(e) => {
            const tid = Number(e.target.value)
            if (tid) onAddTag(p, tid)
          }}
        >
          <option value="">+ tag</option>
          {tags
            .filter((t) => !p.tags.includes(t.name))
            .map((t) => (
              <option key={t.id} value={t.id}>
                #{t.name}
              </option>
            ))}
        </select>
        <button
          className={`icon-btn ${p.note ? 'has-note' : ''}`}
          aria-label={`Note pour ${p.name}`}
          title={p.note ? `Note : ${p.note.slice(0, 160)}` : 'Note'}
          onClick={() => onOpenNote(p)}
        >
          📝
        </button>
      </div>
    </li>
  )
})

function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <li className="skeleton-row" key={i} aria-hidden="true">
          <span className="sk-dot" />
          <div className="sk-lines">
            <span className="sk-line" style={{ width: '38%' }} />
            <span className="sk-line" style={{ width: '55%' }} />
            <span className="sk-line" style={{ width: '24%' }} />
          </div>
        </li>
      ))}
    </>
  )
}

export function ProgramsScreen() {
  const [programs, setPrograms] = useState<ProgramSummary[]>([])
  const [total, setTotal] = useState(0)
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [tags, setTags] = useState<TagInfo[]>([])
  const [sort, setSort] = useState<'name' | 'bounty' | 'recent'>('name')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [activeGroup, setActiveGroup] = useState<number | null>(null)
  const [activeTag, setActiveTag] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [fetching, setFetching] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [noteTarget, setNoteTarget] = useState<ProgramSummary | null>(null)
  const [detailTarget, setDetailTarget] = useState<ProgramSummary | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [newGroupName, setNewGroupName] = useState('')
  const [newTagName, setNewTagName] = useState('')
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')

  const searchRef = useRef<HTMLInputElement>(null)
  // Numéro de séquence de la dernière requête de liste : une réponse lente qui
  // arrive après une réponse plus récente est jetée au lieu d'écraser l'écran.
  const listSeq = useRef(0)
  const favoriteOnlyRef = useRef(favoriteOnly)
  favoriteOnlyRef.current = favoriteOnly
  // Un total à zéro ne veut pas dire « base vide » quand un filtre est actif.
  const hasActiveFilters = (): boolean =>
    favoriteOnly || activeGroup !== null || activeTag !== null || search.trim() !== ''

  const loadList = useCallback(
    async (opts: { append?: boolean; offset?: number } = {}): Promise<void> => {
      const seq = ++listSeq.current
      setFetching(true)
      try {
        const page = await Api.programs.list({
          sort,
          dir,
          favoriteOnly: favoriteOnly || undefined,
          groupId: activeGroup ?? undefined,
          tagId: activeTag ?? undefined,
          search: search.trim() || undefined,
          limit: PAGE_SIZE,
          offset: opts.offset ?? 0
        })
        if (seq !== listSeq.current) return
        setPrograms((prev) => (opts.append ? [...prev, ...page.records] : page.records))
        setTotal(page.total)
      } catch {
        if (seq === listSeq.current) setError('Impossible de charger les programmes.')
      } finally {
        if (seq === listSeq.current) setFetching(false)
      }
    },
    [sort, dir, favoriteOnly, activeGroup, activeTag, search]
  )

  const loadFacets = useCallback(async (): Promise<void> => {
    const [g, t] = await Promise.all([Api.groups.list(), Api.tags.list()])
    setGroups(g)
    setTags(t)
  }, [])

  // Les callbacks de mutation vivent dans des refs : leurs identités restent
  // stables, donc les lignes mémoïsées ne se re-rendent pas à chaque frappe.
  const loadListRef = useRef(loadList)
  loadListRef.current = loadList
  const loadFacetsRef = useRef(loadFacets)
  loadFacetsRef.current = loadFacets

  const reload = useCallback(async (withFacets: boolean): Promise<void> => {
    await loadListRef.current()
    if (withFacets) await loadFacetsRef.current()
  }, [])

  // Un seul effet de chargement : immédiat au montage, filtré à 250 ms ensuite
  // (la version précédente doublonnait la première requête).
  const firstRun = useRef(true)
  useEffect(() => {
    const delay = firstRun.current ? 0 : 250
    const timer = setTimeout(() => {
      firstRun.current = false
      void loadList()
    }, delay)
    return () => clearTimeout(timer)
  }, [loadList])

  useEffect(() => {
    void loadFacets()
  }, [loadFacets])

  // Raccourci clavier : « / » place le curseur dans la recherche, partout où
  // l'utilisateur n'est pas déjà en train de saisir.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const runMutation = useCallback(
    async (fn: () => Promise<unknown>, withFacets = true): Promise<void> => {
      setError(null)
      setNotice(null)
      try {
        await fn()
        await reload(withFacets)
      } catch {
        setError('Une opération a échoué.')
      }
    },
    [reload]
  )

  const handleSync = async (): Promise<void> => {
    setSyncing(true)
    setError(null)
    setNotice(null)
    try {
      const result = await Api.programs.sync()
      if (!result.ok) setError(result.error)
      await reload(true)
    } catch {
      setError('La synchronisation a échoué (réseau ?).')
    } finally {
      setSyncing(false)
    }
  }

  /**
   * Export des programmes **avec les filtres courants** (favori, groupe, tag,
   * recherche), pagination ignorée : c'est la sélection de travail qui part
   * dans le fichier, pas la page affichée.
   */
  const handleExport = async (): Promise<void> => {
    setExporting(true)
    setError(null)
    setNotice(null)
    try {
      const query: ProgramsQuery = {
        sort,
        dir,
        favoriteOnly: favoriteOnly || undefined,
        groupId: activeGroup ?? undefined,
        tagId: activeTag ?? undefined,
        search: search.trim() || undefined
      }
      const r = await Api.programs.export(query, exportFormat)
      if (r.ok) setNotice(`${r.rows} programme${r.rows > 1 ? 's' : ''} exporté${r.rows > 1 ? 's' : ''} — ${r.path}`)
      else if (!r.canceled) setError(r.error)
    } catch {
      setError("L'export a échoué.")
    } finally {
      setExporting(false)
    }
  }

  /** Favori basculé localement d'abord : aucun rechargement de liste. */
  const toggleFavorite = useCallback((p: ProgramSummary): void => {
    const next = !p.favorite
    const dropFromList = favoriteOnlyRef.current && !next
    setPrograms((prev) => {
      const updated = prev.map((x) => (x.id === p.id ? { ...x, favorite: next } : x))
      return dropFromList ? updated.filter((x) => x.id !== p.id) : updated
    })
    if (dropFromList) setTotal((t) => Math.max(0, t - 1))
    void Api.favorites
      .set(p.id, next)
      .then((r) => {
        if (!r.ok) throw new Error(r.error)
      })
      .catch(() => {
        setError("Le favori n'a pas pu être enregistré.")
        void loadListRef.current()
      })
  }, [])

  const openNote = useCallback((p: ProgramSummary): void => {
    setNoteDraft(p.note)
    setNoteTarget(p)
  }, [])

  const openDetail = useCallback((p: ProgramSummary): void => setDetailTarget(p), [])

  const saveNote = (): void => {
    if (!noteTarget) return
    const target = noteTarget
    const draft = noteDraft
    setNoteTarget(null)
    setPrograms((prev) => prev.map((x) => (x.id === target.id ? { ...x, note: draft } : x)))
    setError(null)
    void Api.notes
      .set(target.id, draft)
      .then((r) => {
        if (!r.ok) {
          setError(r.error)
          void loadListRef.current()
        }
      })
      .catch(() => {
        setError("La note n'a pas pu être enregistrée.")
        void loadListRef.current()
      })
  }

  const createGroup = (): void => {
    const name = newGroupName.trim()
    if (!name) return
    setNewGroupName('')
    void runMutation(async () => {
      const r = await Api.groups.create(name)
      if (!r.ok) throw new Error(r.error)
    })
  }

  const renameGroup = (id: number): void => {
    const name = editingGroupName.trim()
    if (!name) return
    setEditingGroupId(null)
    void runMutation(async () => {
      const r = await Api.groups.rename(id, name)
      if (!r.ok) throw new Error(r.error)
    })
  }

  const removeGroup = (id: number): void => {
    if (!window.confirm('Supprimer ce groupe (sans toucher aux programmes) ?')) return
    void runMutation(async () => {
      const r = await Api.groups.remove(id)
      if (!r.ok) throw new Error(r.error)
      if (activeGroup === id) setActiveGroup(null)
    })
  }

  const createTag = (): void => {
    const name = newTagName.trim()
    if (!name) return
    setNewTagName('')
    void runMutation(async () => {
      const r = await Api.tags.create(name)
      if (!r.ok) throw new Error(r.error)
    })
  }

  const removeTag = (id: number): void => {
    void runMutation(async () => {
      const r = await Api.tags.remove(id)
      if (!r.ok) throw new Error(r.error)
      if (activeTag === id) setActiveTag(null)
    })
  }

  const addToGroup = useCallback(
    (p: ProgramSummary, groupId: number): void => {
      void runMutation(async () => {
        const r = await Api.groups.addMember(groupId, p.id)
        if (!r.ok) throw new Error(r.error)
      })
    },
    [runMutation]
  )

  const addTagToProgram = useCallback(
    (p: ProgramSummary, tagId: number): void => {
      void runMutation(async () => {
        const r = await Api.tags.addToProgram(p.id, tagId)
        if (!r.ok) throw new Error(r.error)
      })
    },
    [runMutation]
  )

  const removeTagFromProgram = useCallback(
    (p: ProgramSummary, tagName: string): void => {
      const tag = tags.find((tg) => tg.name === tagName)
      if (tag)
        void runMutation(async () => {
          const r = await Api.tags.removeFromProgram(p.id, tag.id)
          if (!r.ok) throw new Error(r.error)
        })
    },
    [runMutation, tags]
  )

  const loadMore = async (): Promise<void> => {
    const seq = listSeq.current
    setFetching(true)
    try {
      const page = await Api.programs.list({
        sort,
        dir,
        favoriteOnly: favoriteOnly || undefined,
        groupId: activeGroup ?? undefined,
        tagId: activeTag ?? undefined,
        search: search.trim() || undefined,
        limit: PAGE_SIZE,
        offset: programs.length
      })
      if (seq !== listSeq.current) return
      setPrograms((prev) => [...prev, ...page.records])
      setTotal(page.total)
    } catch {
      if (seq === listSeq.current) setError('Impossible de charger la suite.')
    } finally {
      if (seq === listSeq.current) setFetching(false)
    }
  }

  const initialLoading = fetching && programs.length === 0
  const remaining = total - programs.length

  return (
    <div className="section">
      {error && (
        <div className="banner-error" role="alert">
          {error}
          <button className="modal-close" onClick={() => setError(null)} aria-label="Fermer">
            ✕
          </button>
        </div>
      )}

      {notice && (
        <div className="banner-ok" role="status">
          <span className="banner-text">{notice}</span>
          <button className="modal-close" onClick={() => setNotice(null)} aria-label="Fermer">
            ✕
          </button>
        </div>
      )}

      <div className="programs-layout">
        <aside className="filter-pane">
          <div>
            <h3>Groupes</h3>
            <ul>
              <li>
                <button className={`side-item ${activeGroup === null ? 'active' : ''}`} onClick={() => setActiveGroup(null)}>
                  Tous les programmes
                </button>
              </li>
              {groups.map((g) => (
                <li key={g.id}>
                  {editingGroupId === g.id ? (
                    <div className="side-edit">
                      <input
                        value={editingGroupName}
                        onChange={(e) => setEditingGroupName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') renameGroup(g.id)
                          if (e.key === 'Escape') setEditingGroupId(null)
                        }}
                        autoFocus
                      />
                    </div>
                  ) : (
                    <div className="side-row">
                      <button
                        className={`side-item ${activeGroup === g.id ? 'active' : ''}`}
                        title={g.name}
                        onClick={() => setActiveGroup(activeGroup === g.id ? null : g.id)}
                      >
                        <span className="side-label">{g.name}</span>
                        <span className="count">{g.memberCount}</span>
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`Renommer ${g.name}`}
                        title="Renommer"
                        onClick={() => {
                          setEditingGroupId(g.id)
                          setEditingGroupName(g.name)
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="icon-btn danger"
                        aria-label={`Supprimer ${g.name}`}
                        title="Supprimer"
                        onClick={() => removeGroup(g.id)}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="side-create">
              <input
                placeholder="Nouveau groupe…"
                aria-label="Nouveau groupe"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createGroup()
                }}
              />
            </div>
          </div>

          <div>
            <h3>Tags</h3>
            <ul>
              {tags.map((t) => (
                <li key={t.id}>
                  <div className="side-row">
                    <button
                      className={`side-item ${activeTag === t.id ? 'active' : ''}`}
                      title={t.name}
                      onClick={() => setActiveTag(activeTag === t.id ? null : t.id)}
                    >
                      <span className="side-label">#{t.name}</span>
                      <span className="count">{t.count}</span>
                    </button>
                    <button
                      className="icon-btn danger"
                      aria-label={`Supprimer le tag ${t.name}`}
                      title="Supprimer"
                      onClick={() => removeTag(t.id)}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="side-create">
              <input
                placeholder="Nouveau tag… (#)"
                aria-label="Nouveau tag"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createTag()
                }}
              />
            </div>
          </div>
        </aside>

        <div className="programs-content">
          <div className="toolbar">
            <div className="search-wrap">
              <input
                ref={searchRef}
                className="search"
                type="search"
                placeholder="Rechercher par nom, handle ou industrie…"
                aria-label="Rechercher un programme"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && search) {
                    setSearch('')
                    e.currentTarget.blur()
                  }
                }}
              />
              {!search && <kbd className="search-kbd">/</kbd>}
            </div>
            <div className="filter-chip-group">
              <button
                className={`chip ${favoriteOnly ? 'active' : ''}`}
                aria-pressed={favoriteOnly}
                onClick={() => setFavoriteOnly(!favoriteOnly)}
              >
                ★ Favoris
              </button>
              <select
                aria-label="Trier"
                value={sort}
                onChange={(e) => {
                  const next = e.target.value as 'name' | 'bounty' | 'recent'
                  setSort(next)
                  // « Récemment mis à jour » se lit du plus récent au plus
                  // ancien : on aligne le sens sur ce que dit le libellé.
                  if (next === 'recent') setDir('desc')
                }}
              >
                <option value="name">Nom</option>
                <option value="bounty">Prime max</option>
                <option value="recent">Récemment mis à jour</option>
              </select>
              <button
                className="btn dir-toggle"
                aria-label={dir === 'asc' ? 'Ordre croissant — basculer' : 'Ordre décroissant — basculer'}
                title={dir === 'asc' ? 'Croissant' : 'Décroissant'}
                onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')}
              >
                {dir === 'asc' ? '↑' : '↓'}
              </button>
            </div>
            <div className="toolbar-actions">
              <span className={`muted count-pill ${fetching ? 'is-refreshing' : ''}`} aria-live="polite">
                {fetching && programs.length > 0 ? '…' : `${programs.length} / ${total}`}
              </span>
              <select
                aria-label="Format d'export"
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
                <option value="md">Markdown</option>
              </select>
              <button
                className="btn"
                onClick={() => void handleExport()}
                disabled={exporting || total === 0}
                title="Exporte les programmes filtrés (fichier choisi au système)"
              >
                {exporting ? 'Export…' : 'Exporter'}
              </button>
              <button className="btn primary" onClick={() => void handleSync()} disabled={syncing}>
                {syncing ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Synchronisation…
                  </>
                ) : (
                  'Synchroniser'
                )}
              </button>
            </div>
          </div>

          {initialLoading && (
            <ul className="program-list" aria-busy="true">
              <SkeletonRows />
            </ul>
          )}

          {!initialLoading && programs.length === 0 && (
            <div className="empty-state">
              <span className="empty-icon" aria-hidden="true">
                ★
              </span>
              <p>
                {total === 0 && !hasActiveFilters()
                  ? 'Aucun programme. Cliquez sur « Synchroniser » pour importer le catalogue Intigriti.'
                  : 'Aucun résultat avec les filtres actuels.'}
              </p>
              {hasActiveFilters() && (
                <button
                  className="btn small"
                  onClick={() => {
                    setSearch('')
                    setFavoriteOnly(false)
                    setActiveGroup(null)
                    setActiveTag(null)
                  }}
                >
                  Réinitialiser les filtres
                </button>
              )}
            </div>
          )}

          {programs.length > 0 && (
            <ul className={`program-list ${fetching ? 'is-refreshing' : ''}`}>
              {programs.map((p) => (
                <ProgramRow
                  key={p.id}
                  program={p}
                  groups={groups}
                  tags={tags}
                  onToggleFavorite={toggleFavorite}
                  onOpenDetail={openDetail}
                  onOpenNote={openNote}
                  onAddToGroup={addToGroup}
                  onAddTag={addTagToProgram}
                  onRemoveTag={removeTagFromProgram}
                />
              ))}
            </ul>
          )}

          {remaining > 0 && !initialLoading && (
            <div className="load-more">
              <button className="btn" onClick={() => void loadMore()} disabled={fetching}>
                {fetching ? 'Chargement…' : `Afficher ${Math.min(remaining, PAGE_SIZE)} de plus (${remaining} restants)`}
              </button>
            </div>
          )}
        </div>
      </div>

      {detailTarget && <ProgramDetailModal program={detailTarget} onClose={() => setDetailTarget(null)} />}

      {noteTarget && (
        <Modal title={`Note — ${noteTarget.name}`} onClose={() => setNoteTarget(null)}>
          <textarea
            className="note-editor"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="Scope, points d’attention, deadlines…"
            rows={8}
          />
          <div className="modal-footer">
            <button className="primary" onClick={saveNote}>
              Enregistrer
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
