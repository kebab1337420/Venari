import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/shared/ipc'

type Handler = (event: unknown, raw: unknown) => unknown

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  showSaveDialog: vi.fn(),
  repo: {
    listPrograms: vi.fn<(query: unknown) => unknown>(),
    setFavorite: vi.fn<(programId: string, favorite: boolean) => void>(),
    setNote: vi.fn<(programId: string, note: string) => void>(),
    listGroups: vi.fn<() => unknown[]>(),
    createGroup: vi.fn<(name: string) => unknown>(),
    renameGroup: vi.fn<(id: number, name: string) => void>(),
    removeGroup: vi.fn<(id: number) => void>(),
    addToGroup: vi.fn<(groupId: number, programId: string) => void>(),
    removeFromGroup: vi.fn<(groupId: number, programId: string) => void>(),
    listTags: vi.fn<() => unknown[]>(),
    createTag: vi.fn<(name: string) => unknown>(),
    removeTag: vi.fn<(id: number) => void>(),
    addTagToProgram: vi.fn<(programId: string, tagId: number) => void>(),
    removeTagFromProgram: vi.fn<(programId: string, tagId: number) => void>(),
  },
  client: { getToken: vi.fn<() => string | null>() },
  syncPrograms: vi.fn<(client: unknown) => Promise<number>>(),
  exportFileName: vi.fn<(format: string) => string>(),
  exportQuery: vi.fn<(query: unknown) => unknown>(),
  serializeExport: vi.fn<(records: unknown, format: string) => string>(),
  writeFileSync: vi.fn<(path: string, data: string, encoding: string) => void>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      h.handlers.set(channel, fn)
    },
  },
  dialog: { showSaveDialog: h.showSaveDialog },
}))

vi.mock('node:fs', () => ({ writeFileSync: h.writeFileSync }))
vi.mock('../src/main/db', () => ({ getRepository: () => h.repo }))
vi.mock('../src/main/app-state', () => ({ getClient: () => h.client }))
vi.mock('../src/main/services/programs', () => ({ syncPrograms: h.syncPrograms }))
vi.mock('../src/main/services/export', () => ({
  exportFileName: h.exportFileName,
  exportQuery: h.exportQuery,
  serializeExport: h.serializeExport,
}))

import { registerProgramsIpc } from '../src/main/ipc-programs'

const call = (channel: string, raw: unknown): unknown => h.handlers.get(channel)!(null, raw)

beforeAll(() => {
  registerProgramsIpc()
})

beforeEach(() => {
  vi.clearAllMocks()
  h.repo.listPrograms.mockReturnValue({ records: [], total: 0 })
  h.repo.listGroups.mockReturnValue([])
  h.repo.listTags.mockReturnValue([])
  h.client.getToken.mockReturnValue('tok')
  h.syncPrograms.mockResolvedValue(3)
  h.exportFileName.mockReturnValue('programmes.csv')
  h.exportQuery.mockImplementation((query) => query)
  h.serializeExport.mockReturnValue('a,b\n1,2\n')
  h.writeFileSync.mockImplementation(() => undefined)
  h.showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:/tmp/out.csv' })
})

describe('ProgramsList', () => {
  it('transmet la requete validee au depot', () => {
    h.repo.listPrograms.mockReturnValue({ records: [{ programId: 'p1' }], total: 1 })
    const result = call(IPC.ProgramsList, { search: 'acme', sort: 'bounty', dir: 'desc' })
    expect(result).toEqual({ records: [{ programId: 'p1' }], total: 1 })
    expect(h.repo.listPrograms).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'acme', sort: 'bounty', dir: 'desc' }),
    )
  })

  it('accepte une requete vide', () => {
    call(IPC.ProgramsList, undefined)
    expect(h.repo.listPrograms).toHaveBeenCalledWith({})
  })

  it('rejette une requete invalide (limit hors bornes)', () => {
    expect(() => call(IPC.ProgramsList, { limit: 0 })).toThrow()
  })
})

describe('ProgramsSync', () => {
  it('synchronise quand un token est configure', async () => {
    const result = await call(IPC.ProgramsSync, undefined)
    expect(result).toMatchObject({ ok: true, synced: 3 })
    expect(h.syncPrograms).toHaveBeenCalledWith(h.client)
  })

  it('refuse la synchronisation sans token', async () => {
    h.client.getToken.mockReturnValue(null)
    const result = await call(IPC.ProgramsSync, undefined)
    expect(result).toEqual({ ok: false, error: 'Aucun token configuré' })
    expect(h.syncPrograms).not.toHaveBeenCalled()
  })
})

describe('ProgramsExport', () => {
  it('ecrit le fichier choisi et renvoie le nombre de lignes', async () => {
    h.repo.listPrograms.mockReturnValue({ records: [{ programId: 'p1' }, { programId: 'p2' }], total: 2 })
    const result = await call(IPC.ProgramsExport, { format: 'csv' })
    expect(result).toEqual({ ok: true, path: 'C:/tmp/out.csv', rows: 2 })
    expect(h.serializeExport).toHaveBeenCalledWith(expect.any(Array), 'csv')
    expect(h.writeFileSync).toHaveBeenCalledWith('C:/tmp/out.csv', 'a,b\n1,2\n', 'utf8')
  })

  it('refuse des parametres invalides', async () => {
    const result = await call(IPC.ProgramsExport, { format: 'xml' })
    expect(result).toEqual({ ok: false, error: "Paramètres d'export invalides." })
    expect(h.showSaveDialog).not.toHaveBeenCalled()
  })

  it('refuse quand aucun programme ne correspond', async () => {
    h.repo.listPrograms.mockReturnValue({ records: [], total: 0 })
    const result = await call(IPC.ProgramsExport, { format: 'json' })
    expect(result).toMatchObject({ ok: false })
    expect(h.showSaveDialog).not.toHaveBeenCalled()
  })

  it('signale un export annule', async () => {
    h.repo.listPrograms.mockReturnValue({ records: [{ programId: 'p1' }], total: 1 })
    h.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const result = await call(IPC.ProgramsExport, { format: 'md' })
    expect(result).toMatchObject({ ok: false, canceled: true })
  })

  it('remonte une erreur d ecriture', async () => {
    h.repo.listPrograms.mockReturnValue({ records: [{ programId: 'p1' }], total: 1 })
    h.writeFileSync.mockImplementation(() => {
      throw new Error('disque plein')
    })
    const result = await call(IPC.ProgramsExport, { format: 'csv' })
    expect(result).toEqual({ ok: false, error: 'disque plein' })
  })
})

describe('FavoriteSet', () => {
  it('bascule le favori', () => {
    const result = call(IPC.FavoriteSet, { programId: 'p1', favorite: true })
    expect(result).toEqual({ ok: true })
    expect(h.repo.setFavorite).toHaveBeenCalledWith('p1', true)
  })

  it('refuse un identifiant vide', () => {
    const result = call(IPC.FavoriteSet, { programId: '', favorite: true })
    expect(result).toMatchObject({ ok: false })
    expect(h.repo.setFavorite).not.toHaveBeenCalled()
  })
})

describe('NoteSet', () => {
  it('enregistre la note', () => {
    const result = call(IPC.NoteSet, { programId: 'p1', note: 'a suivre' })
    expect(result).toEqual({ ok: true })
    expect(h.repo.setNote).toHaveBeenCalledWith('p1', 'a suivre')
  })

  it('refuse une note invalide', () => {
    const result = call(IPC.NoteSet, { programId: 'p1', note: 42 })
    expect(result).toMatchObject({ ok: false })
    expect(h.repo.setNote).not.toHaveBeenCalled()
  })
})

describe('Groups', () => {
  it('liste les groupes', () => {
    h.repo.listGroups.mockReturnValue([{ id: 1, name: 'Mobile' }])
    expect(call(IPC.GroupsList, undefined)).toEqual([{ id: 1, name: 'Mobile' }])
  })

  it('cree un groupe en trimant le nom', () => {
    h.repo.createGroup.mockReturnValue({ id: 2, name: 'Web' })
    const result = call(IPC.GroupsCreate, '  Web  ')
    expect(result).toEqual({ ok: true, group: { id: 2, name: 'Web' } })
    expect(h.repo.createGroup).toHaveBeenCalledWith('Web')
  })

  it('refuse un nom de groupe vide', () => {
    const result = call(IPC.GroupsCreate, '   ')
    expect(result).toMatchObject({ ok: false })
    expect(h.repo.createGroup).not.toHaveBeenCalled()
  })

  it('renomme un groupe', () => {
    const result = call(IPC.GroupsRename, { id: 2, name: 'Infra' })
    expect(result).toEqual({ ok: true })
    expect(h.repo.renameGroup).toHaveBeenCalledWith(2, 'Infra')
  })

  it('supprime un groupe', () => {
    expect(call(IPC.GroupsRemove, 2)).toEqual({ ok: true })
    expect(h.repo.removeGroup).toHaveBeenCalledWith(2)
  })

  it('ajoute et retire un membre', () => {
    expect(call(IPC.GroupsAddMember, { groupId: 2, programId: 'p1' })).toEqual({ ok: true })
    expect(h.repo.addToGroup).toHaveBeenCalledWith(2, 'p1')
    expect(call(IPC.GroupsRemoveMember, { groupId: 2, programId: 'p1' })).toEqual({ ok: true })
    expect(h.repo.removeFromGroup).toHaveBeenCalledWith(2, 'p1')
  })

  it('refuse un identifiant de groupe invalide', () => {
    const result = call(IPC.GroupsRemove, -1)
    expect(result).toMatchObject({ ok: false })
  })
})

describe('Tags', () => {
  it('liste les etiquettes', () => {
    h.repo.listTags.mockReturnValue([{ id: 1, name: 'urgent' }])
    expect(call(IPC.TagsList, undefined)).toEqual([{ id: 1, name: 'urgent' }])
  })

  it('cree une etiquette en trimant le nom', () => {
    h.repo.createTag.mockReturnValue({ id: 3, name: 'api' })
    const result = call(IPC.TagsCreate, '  api ')
    expect(result).toEqual({ ok: true, tag: { id: 3, name: 'api' } })
    expect(h.repo.createTag).toHaveBeenCalledWith('api')
  })

  it('supprime une etiquette', () => {
    expect(call(IPC.TagsRemove, 3)).toEqual({ ok: true })
    expect(h.repo.removeTag).toHaveBeenCalledWith(3)
  })

  it('ajoute et retire une etiquette a un programme', () => {
    expect(call(IPC.TagsAddToProgram, { programId: 'p1', tagId: 3 })).toEqual({ ok: true })
    expect(h.repo.addTagToProgram).toHaveBeenCalledWith('p1', 3)
    expect(call(IPC.TagsRemoveFromProgram, { programId: 'p1', tagId: 3 })).toEqual({ ok: true })
    expect(h.repo.removeTagFromProgram).toHaveBeenCalledWith('p1', 3)
  })

  it('refuse une etiquette invalide', () => {
    const result = call(IPC.TagsAddToProgram, { programId: 'p1', tagId: 'x' })
    expect(result).toMatchObject({ ok: false })
  })
})
