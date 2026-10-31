import type { ScopeChangeItem, ScopeChangeSummary, ScopeDomain } from '../../shared/ipc'

const SEPARATOR = '|'

/**
 * Cle stable d'une cible. Le tier fait partie de la cle : un endpoint qui
 * passe de in-scope a out-of-scope doit apparaitre a la fois comme retire et
 * comme ajoute, et pas comme inchange.
 */
export function scopeEntryKey(domain: Pick<ScopeDomain, 'endpoint' | 'inScope'>): string {
  return `${domain.inScope ? 'in' : 'out'}${SEPARATOR}${domain.endpoint.trim()}`
}

export function parseScopeEntryKey(key: string): ScopeChangeItem {
  const cut = key.indexOf(SEPARATOR)
  return {
    endpoint: cut === -1 ? key : key.slice(cut + 1),
    inScope: cut === -1 || key.slice(0, cut) !== 'out',
  }
}

/**
 * Empreinte comparable du scope : dedupliquee (l'API peut renvoyer deux fois le
 * meme endpoint) et triee, pour qu'un simple reordonnancement ne soit pas vu
 * comme un changement.
 */
export function scopeEntries(scope: ScopeDomain[]): string[] {
  const keys = new Set<string>()
  for (const domain of scope) {
    if (domain.endpoint.trim() === '') continue
    keys.add(scopeEntryKey(domain))
  }
  return [...keys].sort()
}

export function diffScope(previous: string[], next: string[]): { added: string[]; removed: string[] } {
  const before = new Set(previous)
  const after = new Set(next)
  return {
    added: next.filter((entry) => !before.has(entry)),
    removed: previous.filter((entry) => !after.has(entry)),
  }
}

/** `null` quand rien n'a bouge, pour ne pas afficher un bandeau vide. */
export function scopeChangeSummary(diff: { added: string[]; removed: string[] }): ScopeChangeSummary | null {
  if (diff.added.length === 0 && diff.removed.length === 0) return null
  return {
    added: diff.added.map(parseScopeEntryKey),
    removed: diff.removed.map(parseScopeEntryKey),
  }
}
