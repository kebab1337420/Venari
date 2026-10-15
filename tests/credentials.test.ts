// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const userData = mkdtempSync(join(tmpdir(), 'bountydesk-cred-test-'))

const store: Record<string, any> = {}

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  app: { getPath: () => userData }
}))

let repoImpl: any

vi.mock('../src/main/db', () => ({
  getRepository: () => repoImpl
}))

describe('credentials service', () => {
  beforeEach(async () => {
    store.credentials = []
    let id = 1
    repoImpl = {
      listCredentials: (programId: string) =>
        store.credentials.filter((c: any) => c.program_id === programId),
      getCredential: (cid: number) => store.credentials.find((c: any) => c.id === cid) ?? null,
      createCredential: (args: any) => {
        const r = {
          id: id++,
          program_id: args.programId,
          label: args.label,
          username: args.username,
          secret_enc: args.secretEnc,
          note: args.note,
          updated_at: Date.now()
        }
        store.credentials.push(r)
        return r.id
      },
      updateCredential: (cid: number, patch: any) => {
        const c = store.credentials.find((x: any) => x.id === cid)
        if (!c) return
        if (patch.label !== undefined) c.label = patch.label
        if (patch.username !== undefined) c.username = patch.username
        if (patch.secretEnc !== undefined) c.secret_enc = patch.secretEnc
        if (patch.note !== undefined) c.note = patch.note
        c.updated_at = Date.now()
      },
      removeCredential: (cid: number) => {
        store.credentials = store.credentials.filter((x: any) => x.id !== cid)
      }
    }
  })

  it('listCredentials masque le secret (hasSecret uniquement)', async () => {
    const { addCredential, listCredentials } = await import('../src/main/services/credentials')
    const id = addCredential({ programId: 'p1', label: 'l', username: 'u', secret: 's', note: 'n' })
    expect(id).toBe(1)
    const list = listCredentials('p1')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ hasSecret: true, username: 'u', label: 'l' })
    expect((list[0] as any).secret).toBeUndefined()
    expect((list[0] as any).secret_enc).toBeUndefined()
  })

  it('revealCredentialSecret dechiffre uniquement le secret demande', async () => {
    const { addCredential, revealCredentialSecret } = await import('../src/main/services/credentials')
    const id = addCredential({ programId: 'p1', label: 'l', username: 'u', secret: 'top-secret', note: '' })
    const v = revealCredentialSecret(id)
    expect(v).toBe('top-secret')
    expect(revealCredentialSecret(999)).toBeNull()
  })

  it('revealCredentialSecret retourne "" quand secret vide, null quand illisible', async () => {
    const { revealCredentialSecret } = await import('../src/main/services/credentials')
    store.credentials.push({ id: 5, program_id: 'p', secret_enc: '' })
    expect(revealCredentialSecret(5)).toBe('')
    store.credentials.push({ id: 6, program_id: 'p', secret_enc: 'badhash' })
    const { safeStorage } = await import('electron')
    ;(safeStorage as any).isEncryptionAvailable = () => false
    expect(revealCredentialSecret(6)).toBeNull()
    ;(safeStorage as any).isEncryptionAvailable = () => true
  })

  it('updateCredentialPatch n ecrase pas le secret si champ vide', async () => {
    const { addCredential, updateCredentialPatch, revealCredentialSecret } = await import('../src/main/services/credentials')
    const id = addCredential({ programId: 'p', label: 'l', username: 'u', secret: 'old', note: 'n' })
    updateCredentialPatch(id, { label: 'L2', secret: '' })
    expect(revealCredentialSecret(id)).toBe('old')
  })

  it('updateCredentialPatch chiffre un nouveau secret', async () => {
    const { addCredential, updateCredentialPatch, revealCredentialSecret } = await import('../src/main/services/credentials')
    const id = addCredential({ programId: 'p', label: 'l', username: 'u', secret: 'old', note: 'n' })
    updateCredentialPatch(id, { secret: 'new' })
    expect(revealCredentialSecret(id)).toBe('new')
  })

  it('removeCredential supprime l entree', async () => {
    const { addCredential, removeCredential, listCredentials } = await import('../src/main/services/credentials')
    const id = addCredential({ programId: 'p', label: 'l', username: 'u', secret: 's', note: '' })
    removeCredential(id)
    expect(listCredentials('p')).toHaveLength(0)
  })
})
