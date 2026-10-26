// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GroupInfo, ProgramSummary, TagInfo } from '../src/shared/ipc'

const api = vi.hoisted(() => ({
  programs: { list: vi.fn() },
  groups: { list: vi.fn() },
  tags: { list: vi.fn(), removeFromProgram: vi.fn() },
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
