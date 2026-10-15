import { decryptSecret, encryptSecret } from '../storage'
import { getRepository } from '../db'
import type { CredentialInput, CredentialRecord } from '../../shared/ipc'

/**
 * Meme politique de chiffrement que config.json (storage.ts) : trousseau
 * systeme quand il est disponible, repli AES-256-GCM local sinon — un poste
 * Linux sans keyring doit pouvoir enregistrer ses credentials, comme il peut
 * deja enregistrer son token Intigriti. Le prefixe `enc:` marque une valeur
 * chiffrée (toute valeur sans ce prefixe est refusee a la lecture).
 */
function encrypt(secret: string): string {
  return 'enc:' + encryptSecret(secret)
}

/** @returns null quand le secret est illisible (clé perdue, safeStorage absent). */
function decrypt(enc: string): string | null {
  if (!enc || !enc.startsWith('enc:')) return null
  return decryptSecret(enc.slice(4))
}

export function listCredentials(programId: string): CredentialRecord[] {
  return getRepository().listCredentials(programId).map((c) => ({
    id: c.id,
    programId: c.program_id,
    label: c.label,
    username: c.username,
    hasSecret: c.secret_enc !== '',
    note: c.note,
    updatedAt: c.updated_at,
  }))
}

/**
 * Dechiffre un secret a la demande, pour la seule ligne que l'utilisateur a choisi de reveler.
 * @returns null si le secret existe mais est illisible : renvoyer '' ferait croire
 * a l'utilisateur que son secret est vide.
 */
export function revealCredentialSecret(id: number): string | null {
  const row = getRepository().getCredential(id)
  if (!row) return null
  if (row.secret_enc === '') return ''
  return decrypt(row.secret_enc)
}

export function addCredential(input: CredentialInput): number {
  return getRepository().createCredential({
    programId: input.programId,
    label: input.label,
    username: input.username,
    secretEnc: encrypt(input.secret),
    note: input.note,
  })
}

export function updateCredentialPatch(id: number, patch: Partial<CredentialInput>): void {
  getRepository().updateCredential(id, {
    label: patch.label,
    username: patch.username,
    // Un secret vide veut dire « je n'en change pas » (promesse du formulaire) :
    // l'écraser par '' détruirait le secret stocké sans que l'utilisateur le veuille.
    secretEnc: patch.secret !== undefined && patch.secret !== '' ? encrypt(patch.secret) : undefined,
    note: patch.note,
  })
}

export function removeCredential(id: number): void {
  getRepository().removeCredential(id)
}