import type { Domain, IntigritiClient, RulesVersion } from '../../services/intigriti'
import { getRepository } from '../db'
import type { ProgramDetailData, RoeInfo, ScopeDomain } from '../../shared/ipc'
import { diffScope, scopeChangeSummary, scopeEntries } from './scope-diff'

/**
 * Un domaine est hors scope quand son tier est la sentinelle "Out of scope" de
 * l'API Intigriti (enumeration tier id 5). Le champ `type` decrit la nature de
 * l'actif (URL, Wildcard, IP range...), pas son appartenance au scope : s'en
 * servir pour detecter le scope marquait tous les domaines hors scope et vidait
 * la liste des cibles de scan.
 * @see https://intigriti.readme.io/reference/programs (Program domain tier)
 */
const OUT_OF_SCOPE_TIER = /out[- ]?of[- ]?scope/i

function toScopeDomain(d: Domain): ScopeDomain {
  const type = d.type.value
  return {
    id: d.id,
    type,
    endpoint: d.endpoint,
    tier: d.tier.value,
    description: d.description,
    inScope: !OUT_OF_SCOPE_TIER.test(d.tier.value),
  }
}

function toRoe(r: RulesVersion): RoeInfo {
  const c = r.content
  if (!c) {
    return {
      description: '',
      intigritiMe: false,
      automatedTooling: null,
      userAgent: null,
      requestHeader: null,
      safeHarbour: false,
      attachments: r.attachments ?? [],
    }
  }
  const req = c.testingRequirements ?? {}
  return {
    description: c.description,
    intigritiMe: req.intigritiMe ?? false,
    automatedTooling: req.automatedTooling ?? null,
    userAgent: req.userAgent ?? null,
    requestHeader: req.requestHeader ?? null,
    safeHarbour: c.safeHarbour,
    attachments: r.attachments ?? [],
  }
}

export async function fetchProgramDetail(client: IntigritiClient, programId: string): Promise<ProgramDetailData> {
  const repo = getRepository()
  const row = repo.getProgram(programId)

  const detail = await client.getProgram(programId)
  const domainsData = await client.getProgramDomains(programId, detail.domains.id)
  const roeRules = detail.rulesOfEngagement ? await client.getProgramRules(programId, detail.rulesOfEngagement.id) : null

  const scope = domainsData.domains.content?.map(toScopeDomain) ?? []
  const roe = roeRules?.rulesOfEngagement ? toRoe(roeRules.rulesOfEngagement) : null
  const fetchedAt = Date.now()

  // Diff avant d'ecraser l'empreinte : la premiere consultation ne signale rien
  // (pas de reference), les suivantes listent les cibles apparues/disparues.
  const entries = scopeEntries(scope)
  const previous = repo.getScopeState(programId)
  const scopeChanges = previous ? scopeChangeSummary(diffScope(previous.entries, entries)) : null
  repo.saveScopeState(programId, entries, fetchedAt)

  repo.setProgramDetail(programId, JSON.stringify(scope), roe ? JSON.stringify(roe) : null, fetchedAt)

  return {
    programId,
    handle: detail.handle,
    name: detail.name,
    status: detail.status?.value ?? null,
    type: detail.type?.value ?? null,
    confidentiality: detail.confidentialityLevel?.value ?? null,
    industry: detail.industry ?? null,
    webLink: detail.webLinks?.detail ?? row?.webLink ?? null,
    minBounty: row?.minBounty ?? null,
    maxBounty: row?.maxBounty ?? null,
    scope,
    roe,
    fetchedAt,
    scopeChanges,
  }
}

export function getCachedProgramDetail(programId: string): ProgramDetailData | null {
  const repo = getRepository()
  const row = repo.getProgramDetail(programId)
  const prog = repo.getProgram(programId)
  if (!row || !prog) return null
  let scope: ScopeDomain[] = []
  let roe: RoeInfo | null = null
  try {
    if (row.scopeJson) scope = JSON.parse(row.scopeJson) as ScopeDomain[]
    if (row.roeJson) roe = JSON.parse(row.roeJson) as RoeInfo
  } catch {
    return null
  }
  return {
    programId,
    handle: prog.handle,
    name: prog.name,
    status: prog.status,
    type: prog.type,
    confidentiality: prog.confidentiality,
    industry: prog.industry,
    webLink: prog.webLink,
    minBounty: prog.minBounty,
    maxBounty: prog.maxBounty,
    scope,
    roe,
    fetchedAt: row.fetchedAt,
    scopeChanges: null,
  }
}