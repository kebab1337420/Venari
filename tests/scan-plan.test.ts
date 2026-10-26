import { describe, expect, it } from 'vitest'
import { buildPlan, selectTargets } from '../src/main/services/scan/plan'
import type { ScopeDomain } from '../src/shared/ipc'

function d(partial: Partial<ScopeDomain> & { endpoint: string }): ScopeDomain {
  return {
    id: partial.id ?? Math.random().toString(),
    type: partial.type ?? 'in-scope',
    endpoint: partial.endpoint,
    tier: partial.tier ?? 'low',
    description: partial.description ?? '',
    inScope: partial.inScope ?? true,
  }
}

describe('selectTargets', () => {
  it('garde uniquement les cibles in-scope http(s) en dédupliquant et normalisant', () => {
    const scope: ScopeDomain[] = [
      d({ endpoint: 'https://app.example.com/' }),
      d({ endpoint: 'https://app.example.com' }),
      d({ endpoint: 'example.org' }),
      d({ endpoint: 'https://out.example.com', inScope: false }),
      d({ endpoint: 'ftp://legacy.example.com' }),
      d({ endpoint: 'not a url' }),
    ]
    const targets = selectTargets(scope)
    expect(targets).toEqual(['https://app.example.com', 'https://example.org'])
  })

  it('renvoie une liste vide quand il n’y a aucune cible valide', () => {
    expect(selectTargets([d({ endpoint: 'https://x.example.com', inScope: false })])).toEqual([])
  })

  it('écarte les hôtes privés/loopback (garde réseau interne)', () => {
    const scope: ScopeDomain[] = [
      d({ endpoint: 'http://127.0.0.1/' }),
      d({ endpoint: 'https://10.0.0.5/admin' }),
      d({ endpoint: 'https://192.168.1.10/x' }),
      d({ endpoint: 'http://localhost/' }),
      d({ endpoint: 'https://172.16.4.9/' }),
      d({ endpoint: 'https://169.254.169.254/meta' }),
      d({ endpoint: 'https://scan.example.com/' }),
    ]
    const targets = selectTargets(scope)
    expect(targets).toEqual(['https://scan.example.com'])
  })

  it('écarte les loopback IPv6 et les adresses mappées (hostname rendu entre crochets)', () => {
    const scope: ScopeDomain[] = [
      d({ endpoint: 'http://[::1]/' }),
      d({ endpoint: 'http://[::ffff:127.0.0.1]/' }),
      d({ endpoint: 'http://[::ffff:a00:1]/' }),
      d({ endpoint: 'http://localhost./' }),
      d({ endpoint: 'https://100.64.1.1/' }),
      d({ endpoint: 'https://scan.example.com/' }),
    ]
    expect(selectTargets(scope)).toEqual(['https://scan.example.com'])
  })

  it('écarte les wildcards, que curl et nuclei ne peuvent pas résoudre', () => {
    const scope: ScopeDomain[] = [
      d({ endpoint: '*.example.com' }),
      d({ endpoint: 'https://*.api.example.com/v1' }),
      d({ endpoint: 'app.example.com' }),
    ]
    expect(selectTargets(scope)).toEqual(['https://app.example.com'])
  })

  it('ne bloque pas les IPv6 publiques', () => {
    expect(selectTargets([d({ endpoint: 'https://[2606:4700::1111]/' })])).toEqual([
      'https://[2606:4700::1111]',
    ])
  })

  it('applique le user-agent et le header de requête des ROE au plan', () => {
    const plan = buildPlan('med', ['https://a.example.com'], 5, {
      userAgent: 'BotDE/1.0',
      requestHeader: 'X-Bounty-Desk: 1',
    })
    expect(plan.userAgent).toBe('BotDE/1.0')
    expect(plan.requestHeader).toBe('X-Bounty-Desk: 1')
    const curl = plan.steps[0]!
    expect(curl.args).toContain('-A')
    expect(curl.args).toContain('BotDE/1.0')
    expect(curl.args).toContain('-H')
    expect(curl.args).toContain('X-Bounty-Desk: 1')
  })

  it('garde le user-agent par défaut si les ROE n’en imposent pas', () => {
    const plan = buildPlan('low', ['https://a.example.com'], 1)
    expect(plan.userAgent).toBe('Venari-scan/1.0')
    const curl = plan.steps[0]!
    expect(curl.args).toContain('-A')
    expect(curl.args).toContain('Venari-scan/1.0')
    expect(curl.args).not.toContain('-H')
  })
})

describe('buildPlan', () => {
  const targets = ['https://a.example.com']
  it('produit des étapes pour chaque profil', () => {
    for (const depth of ['low', 'med', 'high'] as const) {
      const plan = buildPlan(depth, targets, 5)
      expect(plan.depth).toBe(depth)
      expect(plan.targets).toEqual(targets)
      expect(plan.steps.length).toBeGreaterThan(0)
      expect(plan.steps[0]!.tool).toBe('curl')
    }
  })

  it('high ajoute ffuf, low ne scanne pas high/critical', () => {
    const low = buildPlan('low', targets, 1)
    const high = buildPlan('high', targets, 1)
    expect(low.steps.some((s) => s.tool === 'ffuf')).toBe(false)
    expect(high.steps.some((s) => s.tool === 'ffuf')).toBe(true)
    expect(high.steps.some((s) => s.args.includes('low,medium,high,critical'))).toBe(true)
  })

  it('respecte le rate limit fourni', () => {
    const plan = buildPlan('med', targets, 42)
    for (const s of plan.steps.filter((x) => x.tool === 'nuclei')) {
      expect(s.args).toContain('42')
    }
  })
})