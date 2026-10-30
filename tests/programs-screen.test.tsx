// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GroupInfo, ProgramSummary, TagInfo } from '../src/shared/ipc'

const api = vi.hoisted(() => ({
  programs: { list: vi.fn() },
  groups: { list: vi.fn(), rename: vi.fn(), addMember: vi.fn() },
  tags: { list: vi.fn(), removeFromProgram: vi.fn(), addToProgram: vi.fn() },
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
  tags: ['web'],
  groups: [],
  updatedAt: 0,
  ...over,
})

const tag: TagInfo = { id: 7, name: 'web', count: 1 }
const group: GroupInfo = { id: 3, name: 'Web', color: null, memberCount: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  api.programs.list.mockResolvedValue({ records: [program()], total: 1 })
  api.groups.list.mockResolvedValue([] as GroupInfo[])
  api.tags.list.mockResolvedValue([tag])
  api.tags.removeFromProgram.mockResolvedValue({ ok: true })
})

describe('ProgramsScreen — tags de ligne', () => {
  it('retire le tag sans ouvrir le détail du programme', async () => {
    render(<ProgramsScreen />)

    fireEvent.click(await screen.findByTitle('Retirer le tag'))

    expect(api.tags.removeFromProgram).toHaveBeenCalledWith('p1', 7)
    expect(screen.queryByRole('dialog')).toBeNull()
    // La liste est rechargée après la mutation.
    await waitFor(() => expect(api.programs.list).toHaveBeenCalledTimes(2))
  })

  it('ne navigue pas quand on active le tag au clavier', async () => {
    render(<ProgramsScreen />)

    const tagButton = await screen.findByTitle('Retirer le tag')
    fireEvent.keyDown(tagButton, { key: 'Enter' })

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('ProgramsScreen — echecs de mutation signales', () => {
  it('affiche une erreur quand le renommage de groupe echoue', async () => {
    api.groups.list.mockResolvedValue([group])
    api.groups.rename.mockResolvedValue({ ok: false, error: 'doublon' })
    render(<ProgramsScreen />)

    fireEvent.click(await screen.findByLabelText('Renommer Web'))
    const input = screen.getByDisplayValue('Web')
    fireEvent.change(input, { target: { value: 'Web 2' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(api.groups.rename).toHaveBeenCalledWith(3, 'Web 2')
    expect(await screen.findByText(/Une opération a échoué/)).toBeTruthy()
  })

  it('affiche une erreur quand l ajout a un groupe echoue', async () => {
    api.groups.list.mockResolvedValue([group])
    api.groups.addMember.mockResolvedValue({ ok: false, error: 'verrou' })
    render(<ProgramsScreen />)

    const select = await screen.findByLabelText('Ajouter Acme Corp à un groupe')
    fireEvent.change(select, { target: { value: '3' } })

    expect(api.groups.addMember).toHaveBeenCalledWith(3, 'p1')
    expect(await screen.findByText(/Une opération a échoué/)).toBeTruthy()
  })

  it('affiche une erreur quand l ajout d un tag echoue', async () => {
    api.tags.list.mockResolvedValue([tag, { id: 9, name: 'urgent', count: 1 } as TagInfo])
    api.tags.addToProgram.mockResolvedValue({ ok: false, error: 'verrou' })
    render(<ProgramsScreen />)

    const select = await screen.findByLabelText('Ajouter un tag à Acme Corp')
    fireEvent.change(select, { target: { value: '9' } })

    expect(api.tags.addToProgram).toHaveBeenCalledWith('p1', 9)
    expect(await screen.findByText(/Une opération a échoué/)).toBeTruthy()
  })

  it('affiche une erreur quand le retrait d un tag echoue', async () => {
    api.tags.removeFromProgram.mockResolvedValue({ ok: false, error: 'verrou' })
    render(<ProgramsScreen />)

    fireEvent.click(await screen.findByTitle('Retirer le tag'))

    expect(await screen.findByText(/Une opération a échoué/)).toBeTruthy()
  })
})
