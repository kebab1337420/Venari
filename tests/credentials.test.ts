import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mockUserData = ''
let keyringAvailable = true

vi.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  safeStorage: {
    isEncryptionAvailable: () => keyringAvailable,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString().slice(4),
  },
  ipcMain: { handle: vi.fn() },
}))

import {
  addCredential,
  listCredentials,
  removeCredential,
  revealCredentialSecret,
  updateCredentialPatch,
} from '../src/main/services/credentials'
import { closeDb, getRepository } from '../src/main/db'

const PROGRAM = 'prog-1'

function add(): number {
  return addCredential({ programId: PROGRAM, label: 'Compte', username: 'alice', secret: 's3cret!', note: '' })
}

beforeEach(() => {
  closeDb()
  keyringAvailable = true
  mockUserData = mkdtempSync(join(tmpdir(), 'venari-cred-'))
  getRepository().upsertProgram({
    id: PROGRAM,
    handle: 'acme',
    name: 'Acme Corp',
    type: 'public',
    status: 'active',
    confidentiality: 'public',
    minBounty: null,
    maxBounty: null,
    industry: null,
    webLink: null,
    following: false,
    rawJson: null,
  })
})

describe('credentials : chiffrement au repos', () => {
  it('avec le trousseau système, le secret est chiffré et relisible', () => {
    const id = add()
    expect(revealCredentialSecret(id)).toBe('s3cret!')
    const row = getRepository().getCredential(id)!
    expect(row.secret_enc.startsWith('enc:')).toBe(true)
    expect(row.secret_enc).not.toContain('s3cret!')
    expect(listCredentials(PROGRAM)[0]).toMatchObject({ hasSecret: true, username: 'alice' })
  })

  it('sans trousseau système (Linux sans keyring), enregistre quand même via le repli AES-GCM', () => {
    keyringAvailable = false
    const id = add()
    const row = getRepository().getCredential(id)!
    expect(row.secret_enc.startsWith('enc:aesgcm.v1.')).toBe(true)
    expect(row.secret_enc).not.toContain('s3cret!')
    expect(revealCredentialSecret(id)).toBe('s3cret!')
  })

  it('lit encore un secret chiffré à l’ancienne (safeStorage, préfixe enc: simple)', () => {
    const legacy = 'enc:' + Buffer.from('enc:ancien').toString('base64')
    getRepository().createCredential({ programId: PROGRAM, label: 'Ancien', username: 'bob', secretEnc: legacy, note: '' })
    const id = listCredentials(PROGRAM)[0]!.id
    expect(revealCredentialSecret(id)).toBe('ancien')
  })

  it('un secret legacy devient illisible (null, pas "") sans trousseau système', () => {
    const legacy = 'enc:' + Buffer.from('enc:ancien').toString('base64')
    getRepository().createCredential({ programId: PROGRAM, label: 'Ancien', username: 'bob', secretEnc: legacy, note: '' })
    const id = listCredentials(PROGRAM)[0]!.id
    keyringAvailable = false
    expect(revealCredentialSecret(id)).toBeNull()
  })

  it('refuse une valeur sans le préfixe enc: (pas de secret en clair hérité)', () => {
    getRepository().createCredential({ programId: PROGRAM, label: 'Clair', username: 'carol', secretEnc: 'en-clair', note: '' })
    const id = listCredentials(PROGRAM)[0]!.id
    expect(revealCredentialSecret(id)).toBeNull()
  })

  it('un secret vide à la mise à jour ne détruit pas le secret stocké', () => {
    const id = add()
    updateCredentialPatch(id, { username: 'alice2', secret: '' })
    expect(revealCredentialSecret(id)).toBe('s3cret!')
    updateCredentialPatch(id, { secret: 'nouveau' })
    expect(revealCredentialSecret(id)).toBe('nouveau')
  })

  it('la suppression retire la ligne de credentials', () => {
    const id = add()
    removeCredential(id)
    expect(getRepository().getCredential(id)).toBeUndefined()
    expect(listCredentials(PROGRAM)).toHaveLength(0)
  })
})
