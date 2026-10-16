import type { ProgramOverview } from '../../services/intigriti/schema'
import { paginate, type IntigritiClient } from '../../services/intigriti'
import type { ProgramInput } from '../db/repo'
import { getRepository } from '../db'

export function toProgramInput(p: ProgramOverview): ProgramInput {
  return {
    id: p.id,
    handle: p.handle,
    name: p.name,
    type: p.type?.value ?? null,
    status: p.status?.value ?? null,
    confidentiality: p.confidentialityLevel?.value ?? null,
    minBounty: p.minBounty && p.minBounty.value !== null ? { value: p.minBounty.value, currency: p.minBounty.currency } : null,
    maxBounty: p.maxBounty && p.maxBounty.value !== null ? { value: p.maxBounty.value, currency: p.maxBounty.currency } : null,
    industry: p.industry ?? null,
    webLink: p.webLinks?.detail ?? null,
    following: p.following,
    // On ne persiste pas le blob complet de l'API : il n'est lu par personne et
    // finissait par dupliquer en clair, au repos, tout le detail renvoye par
    // Intigriti. Seuls les champs ci-dessus sont stockes.
    rawJson: null,
  }
}

export async function syncPrograms(client: IntigritiClient, followingOnly = false): Promise<number> {
  const programs = await paginate(
    (offset) => client.listPrograms({ limit: 200, offset, following: followingOnly || undefined }),
    { limit: 200 },
  )
  const rows = programs.map(toProgramInput)
  getRepository().upsertPrograms(rows)
  return rows.length
}