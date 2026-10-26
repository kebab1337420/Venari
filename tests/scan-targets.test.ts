import { describe, expect, it } from 'vitest'
import { resolveScannableTarget, resolveWebTarget } from '../src/shared/scan-targets'

describe('resolveWebTarget', () => {
  it('accepte un endpoint http(s) tel quel', () => {
    expect(resolveWebTarget('https://a.example.com/path')?.href).toBe('https://a.example.com/path')
    expect(resolveWebTarget('http://a.example.com')?.href).toBe('http://a.example.com/')
  })

  it('suppose https quand le schema est absent', () => {
    expect(resolveWebTarget('a.example.com')?.href).toBe('https://a.example.com/')
    expect(resolveWebTarget('*.a.example.com')?.href).toBe('https://*.a.example.com/')
    expect(resolveWebTarget('  a.example.com  ')?.href).toBe('https://a.example.com/')
  })

  it('refuse un schema explicite non http(s)', () => {
    expect(resolveWebTarget('ftp://a.example.com')).toBeNull()
    expect(resolveWebTarget('data:text/plain,x')).toBeNull()
    expect(resolveWebTarget('mailto:a@b.com')).toBeNull()
  })

  it('refuse une entree vide ou invalide', () => {
    expect(resolveWebTarget('')).toBeNull()
    expect(resolveWebTarget('   ')).toBeNull()
    expect(resolveWebTarget('not a url')).toBeNull()
  })
})

describe('resolveScannableTarget', () => {
  it('garde les endpoints concrets', () => {
    expect(resolveScannableTarget('app.example.com')?.href).toBe('https://app.example.com/')
    expect(resolveScannableTarget('https://app.example.com/path')?.href).toBe('https://app.example.com/path')
  })

  it('écarte les wildcards, qui ne sont pas des cibles concrètes', () => {
    expect(resolveScannableTarget('*.example.com')).toBeNull()
    expect(resolveScannableTarget('https://*.api.example.com/v1')).toBeNull()
    expect(resolveScannableTarget('*')).toBeNull()
  })

  it('écarte aussi les entrées invalides', () => {
    expect(resolveScannableTarget('ftp://example.com')).toBeNull()
    expect(resolveScannableTarget('not a url')).toBeNull()
  })
})
