// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Api } from '../src/renderer/src/api'

// Api n'est qu'un pont vers window.bountydesk : ce test verifie que chaque
// methode atteint le bon canal et transmet ses arguments. Une inversion de
// namespace (ex: tags.addToProgram -> groups.addMember) passerait autrement
// inapercue jusqu'a l'execution reelle.
const bridge = {
  auth: { getStatus: vi.fn(), validate: vi.fn(), clear: vi.fn() },
  programs: { list: vi.fn(), sync: vi.fn(), detail: vi.fn(), export: vi.fn() },
  credentials: { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn(), reveal: vi.fn() },
  secret: { copy: vi.fn() },
  shell: { openExternal: vi.fn(), openBrowser: vi.fn() },
  scans: { start: vi.fn(), list: vi.fn(), events: vi.fn(), stop: vi.fn() },
  tools: {
    list: vi.fn(),
    install: vi.fn(),
    onInstallOutput: vi.fn(),
    githubTokenStatus: vi.fn(),
    githubTokenSet: vi.fn(),
    githubTokenClear: vi.fn(),
  },
  mcp: {
    status: vi.fn(),
    setEnabled: vi.fn(),
    regenerateToken: vi.fn(),
    addToken: vi.fn(),
    revokeToken: vi.fn(),
    requests: vi.fn(),
    diagnose: vi.fn(),
    firewallFix: vi.fn(),
    machines: vi.fn(),
    pairingCreate: vi.fn(),
    pairingCancel: vi.fn(),
  },
  agent: {
    tokens: vi.fn(),
    addToken: vi.fn(),
    revokeToken: vi.fn(),
    statuses: vi.fn(),
    sessions: vi.fn(),
    sessionRequest: vi.fn(),
    sessionDecide: vi.fn(),
    sessionEnd: vi.fn(),
    viewToken: vi.fn(),
  },
  favorites: { set: vi.fn() },
  notes: { set: vi.fn() },
  groups: { list: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn(), addMember: vi.fn(), removeMember: vi.fn() },
  tags: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), addToProgram: vi.fn(), removeFromProgram: vi.fn() },
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { bountydesk: bridge })
})

describe('Api.auth', () => {
  it('delegue au canal auth', () => {
    Api.auth.status()
    Api.auth.validate('jeton')
    Api.auth.logout()
    expect(bridge.auth.getStatus).toHaveBeenCalledTimes(1)
    expect(bridge.auth.validate).toHaveBeenCalledWith('jeton')
    expect(bridge.auth.clear).toHaveBeenCalledTimes(1)
  })
})

describe('Api.programs', () => {
  it('delegue au canal programs', () => {
    const query = { search: 'acme' }
    Api.programs.list(query)
    Api.programs.sync()
    Api.programs.detail('p1')
    Api.programs.export(query, 'csv')
    expect(bridge.programs.list).toHaveBeenCalledWith(query)
    expect(bridge.programs.sync).toHaveBeenCalledTimes(1)
    expect(bridge.programs.detail).toHaveBeenCalledWith('p1')
    expect(bridge.programs.export).toHaveBeenCalledWith(query, 'csv')
  })
})

describe('Api.credentials', () => {
  it('delegue au canal credentials', () => {
    const input = { programId: 'p1', label: 'x', username: '', secret: '', note: '' }
    Api.credentials.list('p1')
    Api.credentials.add(input)
    Api.credentials.update(4, { note: 'n' })
    Api.credentials.remove(4)
    Api.credentials.reveal(4)
    expect(bridge.credentials.list).toHaveBeenCalledWith('p1')
    expect(bridge.credentials.add).toHaveBeenCalledWith(input)
    expect(bridge.credentials.update).toHaveBeenCalledWith(4, { note: 'n' })
    expect(bridge.credentials.remove).toHaveBeenCalledWith(4)
    expect(bridge.credentials.reveal).toHaveBeenCalledWith(4)
  })
})

describe('Api.secret et Api.shell', () => {
  it('delegue au bon canal', () => {
    Api.secret.copy('mcpToken', 'id-1')
    Api.shell.openExternal('https://example.com')
    Api.shell.openBrowser('https://example.com')
    expect(bridge.secret.copy).toHaveBeenCalledWith('mcpToken', 'id-1')
    expect(bridge.shell.openExternal).toHaveBeenCalledWith('https://example.com')
    expect(bridge.shell.openBrowser).toHaveBeenCalledWith('https://example.com')
  })
})

describe('Api.scans', () => {
  it('delegue au canal scans', () => {
    const opts = { depth: 'low' as const, roeConfirm: true, rateLimit: 5 }
    Api.scans.start('p1', opts)
    Api.scans.list('p1')
    Api.scans.events(7, 3)
    Api.scans.stop(7)
    expect(bridge.scans.start).toHaveBeenCalledWith('p1', opts)
    expect(bridge.scans.list).toHaveBeenCalledWith('p1')
    expect(bridge.scans.events).toHaveBeenCalledWith(7, 3)
    expect(bridge.scans.stop).toHaveBeenCalledWith(7)
  })
})

describe('Api.tools', () => {
  it('delegue au canal tools', () => {
    const cb = vi.fn()
    Api.tools.list()
    Api.tools.install('nuclei')
    Api.tools.onInstallOutput(cb)
    Api.tools.githubTokenStatus()
    Api.tools.githubTokenSet('ghp_x')
    Api.tools.githubTokenClear()
    expect(bridge.tools.list).toHaveBeenCalledTimes(1)
    expect(bridge.tools.install).toHaveBeenCalledWith('nuclei')
    expect(bridge.tools.onInstallOutput).toHaveBeenCalledWith(cb)
    expect(bridge.tools.githubTokenStatus).toHaveBeenCalledTimes(1)
    expect(bridge.tools.githubTokenSet).toHaveBeenCalledWith('ghp_x')
    expect(bridge.tools.githubTokenClear).toHaveBeenCalledTimes(1)
  })
})

describe('Api.mcp', () => {
  it('delegue au canal mcp', () => {
    Api.mcp.status()
    Api.mcp.setEnabled(true, { port: 8080, lan: false })
    Api.mcp.regenerateToken()
    Api.mcp.addToken('laptop')
    Api.mcp.revokeToken('id-1')
    Api.mcp.requests(20)
    Api.mcp.diagnose()
    Api.mcp.firewallFix()
    Api.mcp.machines(10)
    Api.mcp.pairingCreate()
    Api.mcp.pairingCancel()
    expect(bridge.mcp.status).toHaveBeenCalledTimes(1)
    expect(bridge.mcp.setEnabled).toHaveBeenCalledWith(true, { port: 8080, lan: false })
    expect(bridge.mcp.regenerateToken).toHaveBeenCalledTimes(1)
    expect(bridge.mcp.addToken).toHaveBeenCalledWith('laptop')
    expect(bridge.mcp.revokeToken).toHaveBeenCalledWith('id-1')
    expect(bridge.mcp.requests).toHaveBeenCalledWith(20)
    expect(bridge.mcp.diagnose).toHaveBeenCalledTimes(1)
    expect(bridge.mcp.firewallFix).toHaveBeenCalledTimes(1)
    expect(bridge.mcp.machines).toHaveBeenCalledWith(10)
    expect(bridge.mcp.pairingCreate).toHaveBeenCalledTimes(1)
    expect(bridge.mcp.pairingCancel).toHaveBeenCalledTimes(1)
  })
})

describe('Api.agent', () => {
  it('delegue au canal agent', () => {
    Api.agent.tokens()
    Api.agent.addToken('ci')
    Api.agent.revokeToken('id-1')
    Api.agent.statuses()
    Api.agent.sessions()
    Api.agent.sessionRequest('id-1')
    Api.agent.sessionDecide(5, true)
    Api.agent.sessionEnd('view-tok')
    Api.agent.viewToken()
    expect(bridge.agent.tokens).toHaveBeenCalledTimes(1)
    expect(bridge.agent.addToken).toHaveBeenCalledWith('ci')
    expect(bridge.agent.revokeToken).toHaveBeenCalledWith('id-1')
    expect(bridge.agent.statuses).toHaveBeenCalledTimes(1)
    expect(bridge.agent.sessions).toHaveBeenCalledTimes(1)
    expect(bridge.agent.sessionRequest).toHaveBeenCalledWith('id-1')
    expect(bridge.agent.sessionDecide).toHaveBeenCalledWith(5, true)
    expect(bridge.agent.sessionEnd).toHaveBeenCalledWith('view-tok')
    expect(bridge.agent.viewToken).toHaveBeenCalledTimes(1)
  })
})

describe('Api.favorites et Api.notes', () => {
  it('delegue au bon canal', () => {
    Api.favorites.set('p1', true)
    Api.notes.set('p1', 'note')
    expect(bridge.favorites.set).toHaveBeenCalledWith('p1', true)
    expect(bridge.notes.set).toHaveBeenCalledWith('p1', 'note')
  })
})

describe('Api.groups', () => {
  it('delegue au canal groups', () => {
    Api.groups.list()
    Api.groups.create('Web')
    Api.groups.rename(2, 'Infra')
    Api.groups.remove(2)
    Api.groups.addMember(2, 'p1')
    Api.groups.removeMember(2, 'p1')
    expect(bridge.groups.list).toHaveBeenCalledTimes(1)
    expect(bridge.groups.create).toHaveBeenCalledWith('Web')
    expect(bridge.groups.rename).toHaveBeenCalledWith(2, 'Infra')
    expect(bridge.groups.remove).toHaveBeenCalledWith(2)
    expect(bridge.groups.addMember).toHaveBeenCalledWith(2, 'p1')
    expect(bridge.groups.removeMember).toHaveBeenCalledWith(2, 'p1')
  })
})

describe('Api.tags', () => {
  it('delegue au canal tags', () => {
    Api.tags.list()
    Api.tags.create('urgent')
    Api.tags.remove(3)
    Api.tags.addToProgram('p1', 3)
    Api.tags.removeFromProgram('p1', 3)
    expect(bridge.tags.list).toHaveBeenCalledTimes(1)
    expect(bridge.tags.create).toHaveBeenCalledWith('urgent')
    expect(bridge.tags.remove).toHaveBeenCalledWith(3)
    expect(bridge.tags.addToProgram).toHaveBeenCalledWith('p1', 3)
    expect(bridge.tags.removeFromProgram).toHaveBeenCalledWith('p1', 3)
  })
})

describe('transparence de la valeur de retour', () => {
  it('renvoie exactement ce que le pont produit', () => {
    const sentinel = { ok: true }
    bridge.auth.getStatus.mockReturnValue(sentinel)
    expect(Api.auth.status()).toBe(sentinel)
  })
})
