import { afterEach, describe, expect, it } from 'vitest'
import {
  createPairingCode,
  currentPairing,
  PAIR_CODE_MAX_ATTEMPTS,
  PAIR_CODE_TTL_MS,
  redeemPairingCode,
  resetPairing,
} from '../src/main/services/mcp/pairing'

const NOW = 1_700_000_000_000

afterEach(() => resetPairing())

describe('code d’appairage', () => {
  it('genere un code de 6 caracteres sans caracteres ambigus', () => {
    const { code, expiresAt } = createPairingCode(NOW)
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/)
    expect(expiresAt).toBe(NOW + PAIR_CODE_TTL_MS)
    expect(code).not.toMatch(/[IO01L]/)
  })

  it('expose le code actif et son expiration', () => {
    const { code } = createPairingCode(NOW)
    expect(currentPairing(NOW + 1000)).toEqual({
      code,
      expiresAt: NOW + PAIR_CODE_TTL_MS,
      attemptsLeft: PAIR_CODE_MAX_ATTEMPTS,
    })
  })

  it('accepte un code majuscule, minuscule ou avec separateurs', () => {
    const { code } = createPairingCode(NOW)
    const messy = `${code.slice(0, 2)}-${code.slice(2).toLowerCase()}`
    expect(redeemPairingCode(messy, NOW + 1000)).toEqual({ ok: true })
  })

  it('refuse un mauvais code et decremente les tentatives', () => {
    createPairingCode(NOW)
    expect(redeemPairingCode('ZZZZZZ', NOW + 1)).toEqual({ ok: false, error: 'Code invalide.' })
    expect(currentPairing(NOW + 1)?.attemptsLeft).toBe(PAIR_CODE_MAX_ATTEMPTS - 1)
  })

  it('desactive le code apres le nombre maximal de tentatives', () => {
    createPairingCode(NOW)
    for (let i = 0; i < PAIR_CODE_MAX_ATTEMPTS - 1; i++) {
      expect(redeemPairingCode('ZZZZZZ', NOW + 1).ok).toBe(false)
    }
    const last = redeemPairingCode('ZZZZZZ', NOW + 1)
    expect(last.ok).toBe(false)
    if (!last.ok) expect(last.error).toMatch(/désactivé/)
    // Le code est consomme : meme le bon code ne passe plus.
    expect(currentPairing(NOW + 2)).toBeNull()
  })

  it('expire apres le TTL', () => {
    createPairingCode(NOW)
    expect(redeemPairingCode('ZZZZZZ', NOW + PAIR_CODE_TTL_MS + 1)).toEqual({
      ok: false,
      error: 'Code expiré : générez-en un nouveau.',
    })
    expect(currentPairing(NOW + PAIR_CODE_TTL_MS + 1)).toBeNull()
  })

  it('est a usage unique', () => {
    const { code } = createPairingCode(NOW)
    expect(redeemPairingCode(code, NOW + 1)).toEqual({ ok: true })
    expect(redeemPairingCode(code, NOW + 2)).toEqual({
      ok: false,
      error: 'Aucun code d’appairage actif : générez-en un dans Réglages → Assistant IA.',
    })
  })

  it('refuse tout code sans appairage en cours', () => {
    expect(redeemPairingCode('ZZZZZZ', NOW)).toEqual({
      ok: false,
      error: 'Aucun code d’appairage actif : générez-en un dans Réglages → Assistant IA.',
    })
  })
})
