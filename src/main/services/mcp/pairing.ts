import { randomInt, timingSafeEqual } from 'node:crypto'

export const PAIR_CODE_TTL_MS = 5 * 60_000
export const PAIR_CODE_MAX_ATTEMPTS = 5

const PAIR_CODE_LENGTH = 6
// Alphabet sans I/O/0/1/L : un code dicte ou recopie proprement, sans ambiguite
// de lecture (un « O » lu pour un « 0 » condamne la tentative).
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

interface PairingState {
  code: string
  expiresAt: number
  attempts: number
}

export interface PairingCode {
  code: string
  expiresAt: number
  attemptsLeft: number
}

let state: PairingState | null = null

/** Retire espaces et separateurs, puis passe en majuscules : « abc-def » == « ABCDEF ». */
function normalize(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

function generateCode(): string {
  let out = ''
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)]!
  return out
}

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // La longueur du code est publique (6) ; la comparaison reste a temps constant
  // pour ne pas laisser fuiter le prefixe correct via le temps de reponse.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function createPairingCode(now = Date.now()): PairingCode {
  const code = generateCode()
  state = { code, expiresAt: now + PAIR_CODE_TTL_MS, attempts: 0 }
  return { code, expiresAt: state.expiresAt, attemptsLeft: PAIR_CODE_MAX_ATTEMPTS }
}

/**
 * Code en attente, ou `null`. Le code n'est renvoye qu'au processus principal :
 * le renderer l'affiche a l'humain qui le dicte au poste a appairer.
 */
export function currentPairing(now = Date.now()): PairingCode | null {
  if (!state) return null
  if (now > state.expiresAt || state.attempts >= PAIR_CODE_MAX_ATTEMPTS) {
    state = null
    return null
  }
  return { code: state.code, expiresAt: state.expiresAt, attemptsLeft: PAIR_CODE_MAX_ATTEMPTS - state.attempts }
}

export function redeemPairingCode(raw: string, now = Date.now()): { ok: true } | { ok: false; error: string } {
  if (!state) return { ok: false, error: 'Aucun code d’appairage actif : générez-en un dans Réglages → Assistant IA.' }
  if (now > state.expiresAt) {
    state = null
    return { ok: false, error: 'Code expiré : générez-en un nouveau.' }
  }
  if (state.attempts >= PAIR_CODE_MAX_ATTEMPTS) {
    state = null
    return { ok: false, error: 'Code désactivé après trop de tentatives.' }
  }
  state.attempts += 1
  if (!sameCode(normalize(raw), state.code)) {
    const locked = state.attempts >= PAIR_CODE_MAX_ATTEMPTS
    if (locked) state = null
    return {
      ok: false,
      error: locked ? 'Code invalide : trop de tentatives, code désactivé.' : 'Code invalide.',
    }
  }
  // Usage unique : un code reussi ne peut pas servir une seconde fois.
  state = null
  return { ok: true }
}

export function resetPairing(): void {
  state = null
}
