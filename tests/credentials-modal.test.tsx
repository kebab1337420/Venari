// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CredentialRecord, ProgramSummary } from '../src/shared/ipc'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  reveal: vi.fn(),
  openExternal: vi.fn(),
}))

vi.mock('../src/renderer/src/api', () => ({
  Api: {
    credentials: {
      list: api.list,
      add: api.add,
      update: api.update,
      remove: api.remove,
      reveal: api.reveal,
    },
    shell: { openExternal: api.openExternal },
  },
}))

import { CredentialsModal } from '../src/renderer/src/components/CredentialsModal'

const program = (over: Partial<ProgramSummary> = {}): ProgramSummary => ({
  id: 'p1',
  handle: 'acme',
  name: 'Acme Corp',
  type: null,
  status: null,
  confidentiality: null,
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

const cred = (over: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id: 1,
  programId: 'p1',
  label: 'compte test',
  username: 'tester',
  hasSecret: true,
  note: '',
  updatedAt: 0,
  ...over,
})

const listOk = (credentials: CredentialRecord[]): { ok: true; credentials: CredentialRecord[] } => ({
  ok: true,
  credentials,
})

const renderModal = (p: ProgramSummary = program()) => render(<CredentialsModal program={p} onClose={() => {}} />)

describe('CredentialsModal', () => {
  beforeEach(() => {
    api.list.mockResolvedValue(listOk([cred()]))
    api.add.mockResolvedValue({ ok: true, id: 2 })
    api.update.mockResolvedValue({ ok: true })
    api.remove.mockResolvedValue({ ok: true })
    api.reveal.mockResolvedValue({ ok: true, secret: 's3cret' })
    api.openExternal.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('charge la liste et masque le secret', async () => {
    renderModal()
    expect(await screen.findByText('compte test')).toBeTruthy()
    expect(screen.getByText('tester')).toBeTruthy()
    expect(screen.getByText('••••••••')).toBeTruthy()
    expect(screen.queryByText('s3cret')).toBeNull()
    expect(api.list).toHaveBeenCalledWith('p1')
  })

  it('affiche un message quand aucun identifiant n’est enregistré', async () => {
    api.list.mockResolvedValue(listOk([]))
    renderModal()
    expect(await screen.findByText(/Aucun identifiant enregistré/)).toBeTruthy()
  })

  it('affiche l’erreur de chargement', async () => {
    api.list.mockResolvedValue({ ok: false, error: 'boom' })
    renderModal()
    expect(await screen.findByText('boom')).toBeTruthy()
  })

  it('ajoute un identifiant : libellé requis et rogné', async () => {
    renderModal()
    await screen.findByText('compte test')
    const save = screen.getByText('Enregistrer') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('Libellé (ex : compte test API)'), { target: { value: '  nouveau  ' } })
    fireEvent.change(screen.getByPlaceholderText('Login / email'), { target: { value: 'u2' } })
    fireEvent.change(screen.getByPlaceholderText('Mot de passe / clé'), { target: { value: 'pw' } })
    fireEvent.change(screen.getByPlaceholderText('Note'), { target: { value: 'n' } })
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await waitFor(() =>
      expect(api.add).toHaveBeenCalledWith({ programId: 'p1', label: 'nouveau', username: 'u2', secret: 'pw', note: 'n' })
    )
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('modifie sans envoyer de secret quand le champ est laissé vide', async () => {
    renderModal()
    await screen.findByText('compte test')
    fireEvent.click(screen.getByTitle('Modifier'))
    const label = screen.getByPlaceholderText('Libellé (ex : compte test API)') as HTMLInputElement
    expect(label.value).toBe('compte test')
    fireEvent.change(label, { target: { value: 'renommé' } })
    fireEvent.click(screen.getByText('Enregistrer'))
    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1))
    expect(api.update).toHaveBeenCalledWith(1, { label: 'renommé', username: 'tester', note: '' })
    expect(api.update.mock.calls[0]![1]).not.toHaveProperty('secret')
  })

  it('envoie le nouveau secret quand le champ est rempli', async () => {
    renderModal()
    await screen.findByText('compte test')
    fireEvent.click(screen.getByTitle('Modifier'))
    fireEvent.change(screen.getByPlaceholderText('Nouveau secret (laisser vide pour garder)'), { target: { value: 'newpw' } })
    fireEvent.click(screen.getByText('Enregistrer'))
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(1, { label: 'compte test', username: 'tester', note: '', secret: 'newpw' })
    )
  })

  it('révèle puis masque le secret à la demande', async () => {
    renderModal()
    await screen.findByText('compte test')
    fireEvent.click(screen.getByTitle('Afficher'))
    expect(await screen.findByText('s3cret')).toBeTruthy()
    expect(api.reveal).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByTitle('Masquer'))
    await waitFor(() => expect(screen.queryByText('s3cret')).toBeNull())
  })

  it('affiche l’erreur quand le déchiffrement échoue', async () => {
    api.reveal.mockResolvedValue({ ok: false, error: 'Secret illisible' })
    renderModal()
    await screen.findByText('compte test')
    fireEvent.click(screen.getByTitle('Afficher'))
    expect(await screen.findByText('Secret illisible')).toBeTruthy()
  })

  it('supprime après confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderModal()
    await screen.findByText('compte test')
    fireEvent.click(screen.getByTitle('Supprimer'))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(1))
  })

  it('ne supprime rien si la confirmation est refusée', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    renderModal()
    await screen.findByText('compte test')
    fireEvent.click(screen.getByTitle('Supprimer'))
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1))
    expect(api.remove).not.toHaveBeenCalled()
  })

  it('ouvre la page login quand le programme a un webLink', async () => {
    renderModal(program({ webLink: 'https://app.example.com/login' }))
    fireEvent.click(await screen.findByText('Ouvrir la page login'))
    expect(api.openExternal).toHaveBeenCalledWith('https://app.example.com/login')
  })
})
