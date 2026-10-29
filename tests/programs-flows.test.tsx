// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GroupInfo, ProgramSummary, TagInfo } from '../src/shared/ipc'

const api = vi.hoisted(() => ({
  programs: { list: vi.fn(), export: vi.fn(), sync: vi.fn() },
  groups: { list: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn(), addMember: vi.fn(), removeMember: vi.fn() },
  tags: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), addToProgram: vi.fn(), removeFromProgram: vi.fn() },
  favorites: { set: vi.fn() },
  notes: { set: vi.fn() },
}))

vi.mock('../src/renderer/src/api', () => ({ Api: api }))

import { ProgramsScreen } from '../src/renderer/src/screens/Programs'

afterEach(cleanup)

const program = (over: Partial<ProgramSummary> = {}): ProgramSummary => ({
  id: 'p1',
  handle: 'acme',
  name: 'Acme Corp',
  type: 'bug-bounty',
  status: 'open',
  confidentiality: 'public',
  minBounty: null,
  maxBounty: null,
  industry: null,
  webLink: null,
  following: false,
  favorite: false,
  note: '',
  tags: [],
  groups: [],
  updatedAt: 0,
  ...over,
})

const tag: TagInfo = { id: 7, name: 'web', count: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  api.programs.list.mockResolvedValue({ records: [program()], total: 1 })
  api.programs.export.mockResolvedValue({ ok: true, rows: 1, path: 'C:/export.csv' })
  api.groups.list.mockResolvedValue([] as GroupInfo[])
  api.tags.list.mockResolvedValue([tag])
  api.favorites.set.mockResolvedValue({ ok: true })
  api.notes.set.mockResolvedValue({ ok: true })
})

describe('ProgramsScreen — recherche', () => {
  it('filtre la liste apres le delai de frappe', async () => {
    render(<ProgramsScreen />)
    const input = await screen.findByLabelText('Rechercher un programme')

    fireEvent.change(input, { target: { value: 'acme' } })

    await waitFor(() =>
      expect(api.programs.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'acme', offset: 0 }))
    )
  })

  it('efface la recherche avec Echap', async () => {
    render(<ProgramsScreen />)
    const input = await screen.findByLabelText('Rechercher un programme')

    fireEvent.change(input, { target: { value: 'acme' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect((input as HTMLInputElement).value).toBe('')

    await waitFor(() =>
      expect(api.programs.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: undefined }))
    )
  })

  it('focus la recherche avec la touche /', async () => {
    render(<ProgramsScreen />)
    const input = await screen.findByLabelText('Rechercher un programme')

    fireEvent.keyDown(window, { key: '/' })

    expect(document.activeElement).toBe(input)
  })
})

describe('ProgramsScreen — favoris et notes', () => {
  it('bascule un favori via le pont', async () => {
    render(<ProgramsScreen />)

    fireEvent.click(await screen.findByLabelText('Ajouter aux favoris'))

    expect(api.favorites.set).toHaveBeenCalledWith('p1', true)
  })

  it('signale un echec d enregistrement du favori', async () => {
    api.favorites.set.mockResolvedValue({ ok: false, error: 'verrou' })
    render(<ProgramsScreen />)

    fireEvent.click(await screen.findByLabelText('Ajouter aux favoris'))

    expect(await screen.findByText("Le favori n'a pas pu être enregistré.")).toBeTruthy()
  })

  it('enregistre une note et ferme la modale', async () => {
    render(<ProgramsScreen />)

    fireEvent.click(await screen.findByLabelText('Note pour Acme Corp'))
    const editor = screen.getByPlaceholderText('Scope, points d’attention, deadlines…')
    fireEvent.change(editor, { target: { value: 'priorite haute' } })
    fireEvent.click(screen.getByText('Enregistrer'))

    expect(api.notes.set).toHaveBeenCalledWith('p1', 'priorite haute')
    await waitFor(() => expect(screen.queryByText('Enregistrer')).toBeNull())
  })
})

describe('ProgramsScreen — tri et export', () => {
  const exportButton = async (): Promise<HTMLElement> => {
    const btn = await screen.findByText('Exporter')
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false))
    return btn
  }

  it('trie par prime maximale', async () => {
    render(<ProgramsScreen />)
    const sort = await screen.findByLabelText('Trier')

    fireEvent.change(sort, { target: { value: 'bounty' } })

    await waitFor(() =>
      expect(api.programs.list).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'bounty', dir: 'asc' }))
    )
  })

  it('aligne le sens decroissant sur le tri recent', async () => {
    render(<ProgramsScreen />)
    const sort = await screen.findByLabelText('Trier')

    fireEvent.change(sort, { target: { value: 'recent' } })

    await waitFor(() =>
      expect(api.programs.list).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'recent', dir: 'desc' }))
    )
  })

  it('inverse le sens avec le bouton dedie', async () => {
    render(<ProgramsScreen />)

    fireEvent.click(await screen.findByLabelText('Ordre croissant — basculer'))

    await waitFor(() =>
      expect(api.programs.list).toHaveBeenLastCalledWith(expect.objectContaining({ dir: 'desc' }))
    )
  })

  it('exporte au format choisi', async () => {
    render(<ProgramsScreen />)

    fireEvent.change(await screen.findByLabelText("Format d'export"), { target: { value: 'md' } })
    fireEvent.click(await exportButton())

    await waitFor(() =>
      expect(api.programs.export).toHaveBeenCalledWith(expect.objectContaining({ sort: 'name', dir: 'asc' }), 'md')
    )
    expect(await screen.findByText('1 programme exporté — C:/export.csv')).toBeTruthy()
  })

  it('signale un echec d export', async () => {
    api.programs.export.mockResolvedValue({ ok: false, canceled: false, error: 'disque plein' })
    render(<ProgramsScreen />)

    fireEvent.click(await exportButton())

    expect(await screen.findByText('disque plein')).toBeTruthy()
  })
})

describe('ProgramsScreen — etats vides et pagination', () => {
  it('invite a synchroniser quand la base est vide', async () => {
    api.programs.list.mockResolvedValue({ records: [], total: 0 })
    render(<ProgramsScreen />)

    expect(
      await screen.findByText('Aucun programme. Cliquez sur « Synchroniser » pour importer le catalogue Intigriti.')
    ).toBeTruthy()
    expect(screen.queryByText('Réinitialiser les filtres')).toBeNull()
  })

  it('distingue un filtre sans resultat et le reinitialise', async () => {
    api.programs.list.mockResolvedValue({ records: [], total: 0 })
    render(<ProgramsScreen />)

    fireEvent.click(await screen.findByText('★ Favoris'))
    expect(await screen.findByText('Aucun résultat avec les filtres actuels.')).toBeTruthy()

    fireEvent.click(screen.getByText('Réinitialiser les filtres'))

    expect(screen.getByText('★ Favoris').getAttribute('aria-pressed')).toBe('false')
    await waitFor(() =>
      expect(api.programs.list).toHaveBeenLastCalledWith(expect.objectContaining({ favoriteOnly: undefined }))
    )
  })

  it('charge la page suivante avec le bon offset', async () => {
    api.programs.list.mockResolvedValue({ records: [program()], total: 250 })
    render(<ProgramsScreen />)

    fireEvent.click(await screen.findByText('Afficher 200 de plus (249 restants)'))

    await waitFor(() =>
      expect(api.programs.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 }))
    )
  })
})
