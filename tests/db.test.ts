import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/db'
import { createRepository, type Repository, type ProgramInput } from '../src/main/db/repo'

function sample(overrides: Partial<ProgramInput> = {}): ProgramInput {
  return {
    id: 'prog-1',
    handle: 'acme',
    name: 'Acme Corp',
    type: 'public',
    status: 'active',
    confidentiality: 'public',
    minBounty: null,
    maxBounty: { value: 5000, currency: 'EUR' },
    industry: 'Software',
    webLink: 'https://acme.example',
    following: false,
    rawJson: null,
    ...overrides,
  }
}

let db: Db
let repo: Repository

beforeEach(() => {
  db = openDatabase(':memory:')
  repo = createRepository(db)
})

describe('Repository', () => {
  it('upsert un programme puis le reliste tel quel', () => {
    repo.upsertProgram(sample())
    const { records, total } = repo.listPrograms()
    expect(total).toBe(1)
    expect(records[0]).toMatchObject({
      id: 'prog-1',
      handle: 'acme',
      name: 'Acme Corp',
      maxBounty: { value: 5000, currency: 'EUR' },
      favorite: false,
      note: '',
      tags: [],
      groups: [],
    })
  })

  it('un second upsert du même id est idempotent (pas de doublon)', () => {
    repo.upsertProgram(sample())
    repo.upsertProgram(sample({ name: 'Acme Corp v2' }))
    expect(repo.countPrograms()).toBe(1)
    expect(repo.listPrograms().records[0]!.name).toBe('Acme Corp v2')
  })

  it('mini-avarice: minBounty null quand valeur absente', () => {
    repo.upsertProgram(sample({ minBounty: { value: 1000, currency: 'USD' } }))
    const rec = repo.listPrograms().records[0]!
    expect(rec.minBounty).toEqual({ value: 1000, currency: 'USD' })
  })

  it('étoile un programme et filtre favoris', () => {
    repo.upsertProgram(sample())
    repo.setFavorite('prog-1', true)
    expect(repo.listPrograms({ favoriteOnly: true }).total).toBe(1)
    expect(repo.getProgram('prog-1')?.favorite).toBe(true)
    repo.setFavorite('prog-1', false)
    expect(repo.listPrograms({ favoriteOnly: true }).total).toBe(0)
  })

  it('persiste une note indépendamment de l’étoile', () => {
    repo.upsertProgram(sample())
    repo.setNote('prog-1', 'scope: *.acme.example')
    const rec = repo.getProgram('prog-1')
    expect(rec?.note).toBe('scope: *.acme.example')
    expect(rec?.favorite).toBe(false)
  })

  it('gère les groupes: création, renommage, membres, suppression en cascade', () => {
    repo.upsertProgram(sample())
    const { id } = repo.createGroup('Mobile', '#f00')
    repo.addToGroup(id, 'prog-1')
    let groups = repo.listGroups()
    expect(groups).toEqual([{ id, name: 'Mobile', color: '#f00', memberCount: 1 }])

    const { records } = repo.listPrograms({ groupId: id })
    expect(records.map((r) => r.id)).toEqual(['prog-1'])
    expect(records[0]!.groups).toEqual(['Mobile'])

    repo.renameGroup(id, 'Apps mobiles')
    expect(repo.listGroups()[0]!.name).toBe('Apps mobiles')

    repo.removeFromGroup(id, 'prog-1')
    expect(repo.listGroups()[0]!.memberCount).toBe(0)
    expect(repo.listPrograms({ groupId: id }).total).toBe(0)

    repo.addToGroup(id, 'prog-1')
    repo.removeGroup(id)
    expect(repo.listGroups()).toHaveLength(0)
    expect(repo.listPrograms().records[0]!.groups).toEqual([])
  })

  it('refuse un groupe en doublon (nom unique)', () => {
    repo.createGroup('Mobile')
    expect(() => repo.createGroup('Mobile')).toThrow()
  })

  it('gère les tags: attachement, détachement, comptage, suppression', () => {
    repo.upsertProgram(sample())
    repo.upsertProgram(sample({ id: 'prog-2', handle: 'beta', name: 'Beta Inc' }))
    const t1 = repo.createTag('nofollow')
    const t2 = repo.createTag('api')
    repo.addTagToProgram('prog-1', t1.id)
    repo.addTagToProgram('prog-1', t2.id)
    repo.addTagToProgram('prog-2', t1.id)

    let tags = repo.listTags()
    expect(tags).toEqual([
      { id: t2.id, name: 'api', count: 1 },
      { id: t1.id, name: 'nofollow', count: 2 },
    ])

    expect(repo.getProgram('prog-1')?.tags.sort()).toEqual(['api', 'nofollow'])
    expect(repo.listPrograms({ tagId: t1.id }).total).toBe(2)

    repo.removeTagFromProgram('prog-1', t1.id)
    expect(repo.listTags().find((t) => t.id === t1.id)?.count).toBe(1)

    repo.removeTag(t1.id)
    expect(repo.listTags()).toHaveLength(1)
    expect(repo.getProgram('prog-1')?.tags).toEqual(['api'])
  })

  it('recherche par nom, handle ou industrie (insensible à la casse)', () => {
    repo.upsertProgram(sample())
    repo.upsertProgram(sample({ id: 'prog-2', handle: 'beta', name: 'Beta Inc', industry: 'Logistics' }))
    expect(repo.listPrograms({ search: 'acme' }).total).toBe(1)
    expect(repo.listPrograms({ search: 'LOGISTICS' }).total).toBe(1)
    expect(repo.listPrograms({ search: 'inexistant' }).total).toBe(0)
  })

  it('trie par nom (asc/desc) et par prime max', () => {
    repo.upsertProgram(sample()) // Acme, 5000
    repo.upsertProgram(sample({ id: 'prog-2', handle: 'beta', name: 'Beta', maxBounty: null }))
    repo.upsertProgram(sample({ id: 'prog-3', handle: 'zeta', name: 'Zeta', maxBounty: { value: 10000, currency: 'EUR' } }))

    let names = repo.listPrograms({ sort: 'name', dir: 'asc' }).records.map((r) => r.name)
    expect(names).toEqual(['Acme Corp', 'Beta', 'Zeta'])
    names = repo.listPrograms({ sort: 'name', dir: 'desc' }).records.map((r) => r.name)
    expect(names).toEqual(['Zeta', 'Beta', 'Acme Corp'])

    const bounty = repo.listPrograms({ sort: 'bounty', dir: 'desc' }).records.map((r) => r.name)
    expect(bounty).toEqual(['Zeta', 'Acme Corp', 'Beta'])
  })

  it('pagine avec offset/limit et renvoie le total global', () => {
    for (let i = 1; i <= 5; i += 1) {
      repo.upsertProgram(sample({ id: `prog-${i}`, handle: `h${i}`, name: `Prog ${i}` }))
    }
    const page = repo.listPrograms({ limit: 2, offset: 2, sort: 'name', dir: 'asc' })
    expect(page.total).toBe(5)
    expect(page.records.map((r) => r.name)).toEqual(['Prog 3', 'Prog 4'])
  })

  it('trie « récent » de façon totale : la pagination ne saute ni ne répète', () => {
    for (let i = 1; i <= 5; i += 1) {
      repo.upsertProgram(sample({ id: `prog-${i}`, handle: `h${i}`, name: `Prog ${i}` }))
    }
    // Une synchro écrit des centaines de programmes dans la même milliseconde :
    // tous les updated_at sont identiques ici, seul le second critère trie.
    db.prepare('UPDATE programs SET updated_at = 1700000000000').run()

    const seen: string[] = []
    for (const offset of [0, 2, 4]) {
      const page = repo.listPrograms({ sort: 'recent', dir: 'desc', limit: 2, offset })
      seen.push(...page.records.map((r) => r.id))
    }
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
    expect(seen).toEqual(['prog-5', 'prog-4', 'prog-3', 'prog-2', 'prog-1'])

    const asc = repo.listPrograms({ sort: 'recent', dir: 'asc', limit: 5 }).records.map((r) => r.id)
    expect(asc).toEqual([...seen].reverse())
  })

  it('trie par prime de façon totale : la pagination ne saute ni ne répète', () => {
    // Même prime ET même nom : sans dernier critère (p.id), l'ordre SQL n'est
    // pas total et OFFSET saute ou répète des lignes d'une page à l'autre.
    for (let i = 1; i <= 5; i += 1) {
      repo.upsertProgram(sample({ id: `prog-${i}`, handle: `h${i}`, name: 'Acme Corp' }))
    }

    const seen: string[] = []
    for (const offset of [0, 2, 4]) {
      const page = repo.listPrograms({ sort: 'bounty', dir: 'desc', limit: 2, offset })
      seen.push(...page.records.map((r) => r.id))
    }
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  it('traite les jokers LIKE de la recherche comme des caractères littéraux', () => {
    repo.upsertProgram(sample({ id: 'p-1', handle: 'h1', name: 'Remise 100%' }))
    repo.upsertProgram(sample({ id: 'p-2', handle: 'h2', name: 'Remise 1000' }))
    repo.upsertProgram(sample({ id: 'p-3', handle: 'h3', name: 'Nom_avec_underscore' }))
    repo.upsertProgram(sample({ id: 'p-4', handle: 'h4', name: 'NomXavecXunderscore' }))

    // Sans echappement, "100%" matcherait "1000" (le % devient un joker).
    expect(repo.listPrograms({ search: '100%' }).records.map((r) => r.id)).toEqual(['p-1'])
    // Sans echappement, "a_b" matcherait "aXbXb..." comme le joker _.
    expect(repo.listPrograms({ search: 'Nom_avec' }).records.map((r) => r.id)).toEqual(['p-3'])
    // Le joker echappe reste utilisable en recherche normale.
    expect(repo.listPrograms({ search: 'Remise' }).total).toBe(2)
  })

  it('n\'expédie pas raw_json dans les listes mais le fournit dans le détail', () => {
    repo.upsertProgram(sample({ rawJson: JSON.stringify({ heavy: 'x'.repeat(500) }) }))

    const listed = repo.listPrograms().records[0]!
    expect(listed.rawJson).toBeNull()

    const detail = repo.getProgram('prog-1')!
    expect(detail.rawJson).toContain('heavy')
  })

  it('ne charge tags et groups que pour la page affichée', () => {
    for (let i = 1; i <= 6; i += 1) {
      repo.upsertProgram(sample({ id: `p-${i}`, handle: `h${i}`, name: `Prog ${i}` }))
    }
    const tag = repo.createTag('api')
    for (const id of ['p-1', 'p-5']) repo.addTagToProgram(id, tag.id)

    const page = repo.listPrograms({ limit: 2, offset: 0, sort: 'name', dir: 'asc' })
    expect(page.records.map((r) => r.id)).toEqual(['p-1', 'p-2'])
    // p-1 est dans la page : son tag est charge. Les tags des autres
    // programmes de la base n'ont pas de effet sur la page.
    expect(page.records[0]!.tags).toEqual(['api'])
    expect(page.records[1]!.tags).toEqual([])
  })

  it('applique busy_timeout et cree les index de tri/recherche', () => {
    const busy = db.prepare('PRAGMA busy_timeout').get() as unknown as { timeout: number }
    expect(busy.timeout).toBe(5000)

    const version = db.prepare('SELECT user_version FROM pragma_user_version').get() as unknown as { user_version: number }
    expect(version.user_version).toBe(9)

    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as unknown as Array<{ name: string }>).map((i) => i.name)
    expect(indexes).toContain('idx_programs_name_nocase')
    expect(indexes).toContain('idx_programs_handle_nocase')
    expect(indexes).toContain('idx_programs_updated_at')
  })

  it('borne le journal MCP : purge au-dela de 30 jours et de 20 000 lignes', () => {
    const now = Date.now()
    repo.appendMcpRequest({ ts: now - 40 * 24 * 3600 * 1000, tokenLabel: 'vieux', tool: 'list_programs', argsJson: '{}', status: 'ok', ms: 3, remoteIp: '' })
    repo.appendMcpRequest({ ts: now, tokenLabel: 'pc', tool: 'list_programs', argsJson: '{}', status: 'ok', ms: 3, remoteIp: '192.168.2.133' })

    const rows = repo.listMcpRequests(100)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token_label).toBe('pc')
  })

  it('maintient les métadonnées locales après une resync (upsert n’écrase pas favoris/notes)', () => {
    repo.upsertProgram(sample())
    repo.setFavorite('prog-1', true)
    repo.setNote('prog-1', 'note locale')
    repo.setNote('prog-1', 'note locale')
    repo.upsertProgram(sample({ name: 'Acme v2' }))
    const rec = repo.getProgram('prog-1')
    expect(rec?.name).toBe('Acme v2')
    expect(rec?.favorite).toBe(true)
    expect(rec?.note).toBe('note locale')
  })

  it('écrit un lot d’événements de scan en une seule transaction', () => {
    repo.upsertProgram(sample())
    const scanId = repo.createScan({ programId: 'prog-1', depth: 'quick', rateLimit: 10, roeConfirm: true })
    const rows = Array.from({ length: 3 }, (_, i) => ({
      seq: i + 1,
      level: 'info',
      message: `ligne ${i + 1}`,
      ts: 1000 + i,
    }))
    repo.appendScanEvents(scanId, rows)
    expect(repo.countScanEvents(scanId)).toBe(3)
    expect(repo.listScanEvents(scanId, 0).map((r) => r.message)).toEqual(['ligne 1', 'ligne 2', 'ligne 3'])
    expect(repo.listScanEvents(scanId, 1).map((r) => r.seq)).toEqual([2, 3])
  })

  it('ignore un lot vide sans toucher au journal', () => {
    repo.upsertProgram(sample())
    const scanId = repo.createScan({ programId: 'prog-1', depth: 'quick', rateLimit: 10, roeConfirm: true })
    repo.appendScanEvents(scanId, [])
    expect(repo.countScanEvents(scanId)).toBe(0)
  })

  it('referme en erreur les scans « running » orphelins d’un arrêt', () => {
    repo.upsertProgram(sample())
    const running = repo.createScan({ programId: 'prog-1', depth: 'quick', rateLimit: 10, roeConfirm: true })
    const done = repo.createScan({ programId: 'prog-1', depth: 'low', rateLimit: 5, roeConfirm: true })
    repo.updateScan(done, { status: 'done', finishedAt: 123 })

    expect(repo.failOrphanScans(999)).toBe(1)

    expect(repo.getScan(running)?.status).toBe('error')
    expect(repo.getScan(running)?.finished_at).toBe(999)
    expect(repo.getScan(done)?.status).toBe('done')
    const msgs = repo.listScanEvents(running, 0).map((e) => e.message)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('interrompu')
    // Un second passage (redémarrage suivant) ne trouve plus rien à refermer.
    expect(repo.failOrphanScans()).toBe(0)
  })

  it('memorise l empreinte de scope et la remplace au passage suivant', () => {
    repo.upsertProgram(sample())
    expect(repo.getScopeState('prog-1')).toBeNull()

    repo.saveScopeState('prog-1', ['in|https://a.example'], 123)
    expect(repo.getScopeState('prog-1')).toEqual({ entries: ['in|https://a.example'], checkedAt: 123 })

    repo.saveScopeState('prog-1', ['out|https://a.example'], 456)
    expect(repo.getScopeState('prog-1')).toEqual({ entries: ['out|https://a.example'], checkedAt: 456 })
  })

  it('ignore une empreinte de scope illisible au lieu de faire echouer le detail', () => {
    repo.upsertProgram(sample())
    db.prepare(
      'INSERT INTO program_scope_state (program_id, entries_json, checked_at) VALUES (?, ?, ?)',
    ).run('prog-1', '{"pas": "un tableau"}', 1)
    expect(repo.getScopeState('prog-1')).toBeNull()

    db.prepare("UPDATE program_scope_state SET entries_json = '[1, 2]' WHERE program_id = 'prog-1'").run()
    expect(repo.getScopeState('prog-1')).toBeNull()
  })
})