/**
 * Resolution commune d'un endpoint de scope Intigriti vers une URL web
 * scannable. Partage entre le plan de scan cote main (`scan/plan.ts`) et
 * l'affichage des cibles cote renderer (`ScanModals.tsx`) : sans cette source
 * unique, une des deux copies finit par diverger (bug observe : l'UI exigeait
 * un schema `http(s)://` et masquait les endpoints nus que le backend, lui,
 * scannait en https).
 *
 * Aucune dependance Node : utilisable des deux cotes du pont Electron.
 */
export function resolveWebTarget(endpoint: string): URL | null {
  const raw = endpoint.trim()
  // Schema explicite qui n'est pas http(s) (ftp://, data:, mailto:…) : non
  // scannable par les outils HTTP.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) return null
  // Les endpoints Intigriti sont parfois nus (ex: `app.example.com`,
  // `*.example.com`) : on suppose https.
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url
}

/**
 * URL web directement scannable. Contrairement a `resolveWebTarget`, ecarte les
 * cibles wildcard (`*.example.com`) : curl et nuclei ne resolvent pas un hote
 * contenant `*`. Le statut de l'apex depend du programme et n'est pas deductible
 * de l'endpoint (l'enumeration de sous-domaines n'est pas supportee) : on n'emet
 * donc pas de cible invalide plutot que de deviner.
 *
 * A utiliser pour CIBLER un scan ; `resolveWebTarget` reste la reference pour la
 * normalisation d'hote (ex. `inScopeHosts`, qui conserve le retrait de `*.`).
 */
export function scannableWebTarget(endpoint: string): URL | null {
  const url = resolveWebTarget(endpoint)
  if (!url || url.hostname.includes('*')) return null
  return url
}
