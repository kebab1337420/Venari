// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ScopeDomain } from '../src/shared/ipc'
import {
  diffScope,
  parseScopeEntryKey,
  scopeChangeSummary,
  scopeEntries,
  scopeEntryKey
} from '../src/main/services/scope-diff'

function scope(over: Partial<ScopeDomain> = {}): ScopeDomain {
  return {
    id: 'd1',
    type: 'URL',
    endpoint: 'https://a.acme.com',
    tier: 'Tier 1',
    description: '',
    inScope: true,
    ...over
  }
}

describe('scopeEntryKey', () => {
  it('distingue une cible in-scope d une cible hors scope', () => {
    expect(scopeEntryKey({ endpoint: 'https://a', inScope: true })).toBe('in|https://a')
    expect(scopeEntryKey({ endpoint: 'https://a', inScope: false })).toBe('out|https://a')
  })

  it('ignore les espaces autour de l endpoint', () => {
    expect(scopeEntryKey({ endpoint: '  https://a  ', inScope: true })).toBe('in|https://a')
  })
})

describe('parseScopeEntryKey', () => {
  it('restitue endpoint et appartenance au scope', () => {
    expect(parseScopeEntryKey('in|https://a.acme.com')).toEqual({ endpoint: 'https://a.acme.com', inScope: true })
    expect(parseScopeEntryKey('out|*.acme.com')).toEqual({ endpoint: '*.acme.com', inScope: false })
  })

  it('ne perd pas un endpoint contenant le separateur', () => {
    expect(parseScopeEntryKey('in|https://a/?q=x|y')).toEqual({ endpoint: 'https://a/?q=x|y', inScope: true })
  })
})

describe('scopeEntries', () => {
  it('deduplique, trie et ignore les endpoints vides', () => {
    expect(
      scopeEntries([
        scope({ id: '1', endpoint: 'https://b.acme.com' }),
        scope({ id: '2', endpoint: 'https://a.acme.com' }),
        scope({ id: '3', endpoint: 'https://a.acme.com' }),
        scope({ id: '4', endpoint: '   ' }),
        scope({ id: '5', endpoint: '*.acme.com', inScope: false })
      ])
    ).toEqual(['in|https://a.acme.com', 'in|https://b.acme.com', 'out|*.acme.com'])
  })
})

describe('diffScope', () => {
  it('liste les ajouts et retraits', () => {
    expect(diffScope(['in|https://a', 'out|https://b'], ['in|https://a', 'in|https://c'])).toEqual({
      added: ['in|https://c'],
      removed: ['out|https://b']
    })
  })

  it('ne voit aucun changement quand les ensembles sont egaux', () => {
    expect(diffScope(['in|https://a', 'in|https://b'], ['in|https://b', 'in|https://a'])).toEqual({
      added: [],
      removed: []
    })
  })

  it('traite un endpoint qui change de tier comme un retrait + un ajout', () => {
    expect(diffScope(['in|https://a'], ['out|https://a'])).toEqual({
      added: ['out|https://a'],
      removed: ['in|https://a']
    })
  })
})

describe('scopeChangeSummary', () => {
  it('renvoie null quand rien n a bouge', () => {
    expect(scopeChangeSummary({ added: [], removed: [] })).toBeNull()
  })

  it('convertit les cles en cibles lisibles', () => {
    expect(scopeChangeSummary({ added: ['in|https://new'], removed: ['out|https://old'] })).toEqual({
      added: [{ endpoint: 'https://new', inScope: true }],
      removed: [{ endpoint: 'https://old', inScope: false }]
    })
  })
})
