import { describe, expect, it, vi } from 'vitest'
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type BountyDeskBridge } from '../src/shared/ipc'

// Le preload est la seule barriere entre le renderer (non privilegie) et le
// processus principal. Ce test verifie le contrat exact expose et qu'aucune
// primitive brute d'ipcRenderer ne fuit vers le renderer.
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))

import '../src/preload/index'

const expose = vi.mocked(contextBridge.exposeInMainWorld)
const invoke = vi.mocked(ipcRenderer.invoke)
const on = vi.mocked(ipcRenderer.on)
const removeListener = vi.mocked(ipcRenderer.removeListener)
// L'historique des mocks est remis a zero avant chaque test : on fige l'appel
// d'exposition des le chargement du module.
const exposeCall = expose.mock.calls[0]!
const exposed = exposeCall[1] as BountyDeskBridge

function fresh(): void {
  invoke.mockClear()
  on.mockClear()
  removeListener.mockClear()
}

describe('preload — contrat expose', () => {
  it("expose le pont sous le nom 'bountydesk'", () => {
    expect(exposeCall[0]).toBe('bountydesk')
    expect(exposeCall[1]).toBeTruthy()
  })

  it("ne laisse pas fuiter ipcRenderer vers le renderer", () => {
    expect(Object.keys(exposed)).not.toContain('ipcRenderer')
    for (const namespace of Object.values(exposed)) {
      for (const member of Object.values(namespace as Record<string, unknown>)) {
        expect(typeof member).toBe('function')
      }
    }
  })
})

describe('preload — auth et programmes', () => {
  it('delegue au bon canal', () => {
    fresh()
    exposed.auth.getStatus()
    exposed.auth.validate('jeton')
    exposed.auth.clear()
    expect(invoke).toHaveBeenCalledWith(IPC.AuthStatus)
    expect(invoke).toHaveBeenCalledWith(IPC.AuthValidate, 'jeton')
    expect(invoke).toHaveBeenCalledWith(IPC.AuthClear)
  })

  it('delegue les programmes', () => {
    fresh()
    const query = { search: 'acme' }
    exposed.programs.list(query)
    exposed.programs.sync()
    exposed.programs.detail('p1')
    exposed.programs.export(query, 'csv')
    expect(invoke).toHaveBeenCalledWith(IPC.ProgramsList, query)
    expect(invoke).toHaveBeenCalledWith(IPC.ProgramsSync)
    expect(invoke).toHaveBeenCalledWith(IPC.ProgramDetailGet, 'p1')
    expect(invoke).toHaveBeenCalledWith(IPC.ProgramsExport, { search: 'acme', format: 'csv' })
  })
})

describe('preload — identifiants et secret', () => {
  it('delegue aux canaux credentials', () => {
    fresh()
    const input = { programId: 'p1', label: 'x', username: '', secret: '', note: '' }
    exposed.credentials.list('p1')
    exposed.credentials.add(input)
    exposed.credentials.update(4, { note: 'n' })
    exposed.credentials.remove(4)
    exposed.credentials.reveal(4)
    expect(invoke).toHaveBeenCalledWith(IPC.CredentialsList, 'p1')
    expect(invoke).toHaveBeenCalledWith(IPC.CredentialsAdd, input)
    expect(invoke).toHaveBeenCalledWith(IPC.CredentialsUpdate, { id: 4, patch: { note: 'n' } })
    expect(invoke).toHaveBeenCalledWith(IPC.CredentialsRemove, 4)
    expect(invoke).toHaveBeenCalledWith(IPC.CredentialsReveal, 4)
  })

  it('encapsule la copie de secret', () => {
    fresh()
    exposed.secret.copy('mcpToken', 'id-1')
    expect(invoke).toHaveBeenCalledWith(IPC.SecretCopy, { kind: 'mcpToken', id: 'id-1' })
  })
})

describe('preload — shell, scans et outils', () => {
  it('delegue shell et scans', () => {
    fresh()
    exposed.shell.openExternal('https://example.com')
    exposed.shell.openBrowser()
    const opts = { depth: 'low' as const, roeConfirm: true, rateLimit: 5 }
    exposed.scans.start('p1', opts)
    exposed.scans.list('p1')
    exposed.scans.events(7, 3)
    exposed.scans.exportLog(7)
    exposed.scans.stop(7)
    expect(invoke).toHaveBeenCalledWith(IPC.OpenExternal, 'https://example.com')
    expect(invoke).toHaveBeenCalledWith(IPC.BrowserOpen, undefined)
    expect(invoke).toHaveBeenCalledWith(IPC.ScanStart, { programId: 'p1', ...opts })
    expect(invoke).toHaveBeenCalledWith(IPC.ScanList, 'p1')
    expect(invoke).toHaveBeenCalledWith(IPC.ScanEvents, { scanId: 7, afterSeq: 3 })
    expect(invoke).toHaveBeenCalledWith(IPC.ScanExportLog, 7)
    expect(invoke).toHaveBeenCalledWith(IPC.ScanStop, 7)
  })

  it('delegue les outils et le jeton GitHub', () => {
    fresh()
    exposed.tools.list()
    exposed.tools.install('nuclei')
    exposed.tools.githubTokenStatus()
    exposed.tools.githubTokenSet('ghp_x')
    exposed.tools.githubTokenClear()
    expect(invoke).toHaveBeenCalledWith(IPC.ToolsList)
    expect(invoke).toHaveBeenCalledWith(IPC.ToolsInstall, 'nuclei')
    expect(invoke).toHaveBeenCalledWith(IPC.ToolsGitHubTokenGet)
    expect(invoke).toHaveBeenCalledWith(IPC.ToolsGitHubTokenSet, 'ghp_x')
    expect(invoke).toHaveBeenCalledWith(IPC.ToolsGitHubTokenClear)
  })

  it('abonne et desabonne la sortie d installation', () => {
    fresh()
    const cb = vi.fn()
    const off = exposed.tools.onInstallOutput(cb)

    expect(on).toHaveBeenCalledWith(IPC.ToolsInstallOutput, expect.any(Function))
    const listener = on.mock.calls[0]![1] as (_e: unknown, payload: unknown) => void
    listener({}, { id: 'nuclei', chunk: 'ok' })
    expect(cb).toHaveBeenCalledWith({ id: 'nuclei', chunk: 'ok' })

    off()
    expect(removeListener).toHaveBeenCalledWith(IPC.ToolsInstallOutput, listener)
  })
})

describe('preload — mcp', () => {
  it('delegue chaque operation avec sa charge', () => {
    fresh()
    exposed.mcp.status()
    exposed.mcp.setEnabled(true)
    exposed.mcp.setEnabled(false, { port: 8080, lan: true })
    exposed.mcp.regenerateToken()
    exposed.mcp.addToken('laptop')
    exposed.mcp.revokeToken('id-1')
    exposed.mcp.requests()
    exposed.mcp.requests(20)
    exposed.mcp.diagnose()
    exposed.mcp.firewallFix()
    exposed.mcp.machines()
    exposed.mcp.machines(10)
    exposed.mcp.pairingCreate()
    exposed.mcp.pairingCancel()
    expect(invoke).toHaveBeenCalledWith(IPC.McpStatus)
    expect(invoke).toHaveBeenCalledWith(IPC.McpSetEnabled, { enabled: true, port: null, lan: undefined })
    expect(invoke).toHaveBeenCalledWith(IPC.McpSetEnabled, { enabled: false, port: 8080, lan: true })
    expect(invoke).toHaveBeenCalledWith(IPC.McpRegenerateToken)
    expect(invoke).toHaveBeenCalledWith(IPC.McpTokenAdd, { label: 'laptop' })
    expect(invoke).toHaveBeenCalledWith(IPC.McpTokenRevoke, { id: 'id-1' })
    expect(invoke).toHaveBeenCalledWith(IPC.McpRequests, { limit: null })
    expect(invoke).toHaveBeenCalledWith(IPC.McpRequests, { limit: 20 })
    expect(invoke).toHaveBeenCalledWith(IPC.McpDiagnose)
    expect(invoke).toHaveBeenCalledWith(IPC.McpFirewallFix)
    expect(invoke).toHaveBeenCalledWith(IPC.McpMachines, { limit: null })
    expect(invoke).toHaveBeenCalledWith(IPC.McpMachines, { limit: 10 })
    expect(invoke).toHaveBeenCalledWith(IPC.McpPairingCreate)
    expect(invoke).toHaveBeenCalledWith(IPC.McpPairingCancel)
  })
})

describe('preload — agent', () => {
  it('delegue chaque operation avec sa charge', () => {
    fresh()
    exposed.agent.tokens()
    exposed.agent.addToken('ci')
    exposed.agent.revokeToken('id-1')
    exposed.agent.statuses()
    exposed.agent.sessions()
    exposed.agent.sessionRequest('tok-1')
    exposed.agent.sessionDecide(5, true)
    exposed.agent.sessionEnd('view-tok')
    exposed.agent.viewToken()
    expect(invoke).toHaveBeenCalledWith(IPC.AgentTokens)
    expect(invoke).toHaveBeenCalledWith(IPC.AgentTokenAdd, { label: 'ci' })
    expect(invoke).toHaveBeenCalledWith(IPC.AgentTokenRevoke, { id: 'id-1' })
    expect(invoke).toHaveBeenCalledWith(IPC.AgentStatuses)
    expect(invoke).toHaveBeenCalledWith(IPC.AgentSessions)
    expect(invoke).toHaveBeenCalledWith(IPC.AgentSessionRequest, { tokenId: 'tok-1' })
    expect(invoke).toHaveBeenCalledWith(IPC.AgentSessionDecide, { sessionId: 5, approve: true })
    expect(invoke).toHaveBeenCalledWith(IPC.AgentSessionEnd, { viewToken: 'view-tok' })
    expect(invoke).toHaveBeenCalledWith(IPC.AgentViewToken)
  })
})

describe('preload — favoris, notes, groupes, tags', () => {
  it('delegue les favoris et notes', () => {
    fresh()
    exposed.favorites.set('p1', true)
    exposed.notes.set('p1', 'note')
    expect(invoke).toHaveBeenCalledWith(IPC.FavoriteSet, { programId: 'p1', favorite: true })
    expect(invoke).toHaveBeenCalledWith(IPC.NoteSet, { programId: 'p1', note: 'note' })
  })

  it('delegue les groupes', () => {
    fresh()
    exposed.groups.list()
    exposed.groups.create('Web')
    exposed.groups.rename(2, 'Infra')
    exposed.groups.remove(2)
    exposed.groups.addMember(2, 'p1')
    exposed.groups.removeMember(2, 'p1')
    expect(invoke).toHaveBeenCalledWith(IPC.GroupsList)
    expect(invoke).toHaveBeenCalledWith(IPC.GroupsCreate, 'Web')
    expect(invoke).toHaveBeenCalledWith(IPC.GroupsRename, { id: 2, name: 'Infra' })
    expect(invoke).toHaveBeenCalledWith(IPC.GroupsRemove, 2)
    expect(invoke).toHaveBeenCalledWith(IPC.GroupsAddMember, { groupId: 2, programId: 'p1' })
    expect(invoke).toHaveBeenCalledWith(IPC.GroupsRemoveMember, { groupId: 2, programId: 'p1' })
  })

  it('delegue les tags', () => {
    fresh()
    exposed.tags.list()
    exposed.tags.create('urgent')
    exposed.tags.remove(3)
    exposed.tags.addToProgram('p1', 3)
    exposed.tags.removeFromProgram('p1', 3)
    expect(invoke).toHaveBeenCalledWith(IPC.TagsList)
    expect(invoke).toHaveBeenCalledWith(IPC.TagsCreate, 'urgent')
    expect(invoke).toHaveBeenCalledWith(IPC.TagsRemove, 3)
    expect(invoke).toHaveBeenCalledWith(IPC.TagsAddToProgram, { programId: 'p1', tagId: 3 })
    expect(invoke).toHaveBeenCalledWith(IPC.TagsRemoveFromProgram, { programId: 'p1', tagId: 3 })
  })
})
