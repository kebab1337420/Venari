import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type BountyDeskBridge, type SecretCopyKind, type ToolInstallOutput } from '../shared/ipc'

const bridge: BountyDeskBridge = {
  auth: {
    getStatus: () => ipcRenderer.invoke(IPC.AuthStatus),
    validate: (token: string) => ipcRenderer.invoke(IPC.AuthValidate, token),
    clear: () => ipcRenderer.invoke(IPC.AuthClear),
  },
  programs: {
    list: (query) => ipcRenderer.invoke(IPC.ProgramsList, query),
    sync: () => ipcRenderer.invoke(IPC.ProgramsSync),
    detail: (programId: string) => ipcRenderer.invoke(IPC.ProgramDetailGet, programId),
    export: (query, format) => ipcRenderer.invoke(IPC.ProgramsExport, { ...query, format }),
  },
  credentials: {
    list: (programId: string) => ipcRenderer.invoke(IPC.CredentialsList, programId),
    add: (input) => ipcRenderer.invoke(IPC.CredentialsAdd, input),
    update: (id: number, patch) => ipcRenderer.invoke(IPC.CredentialsUpdate, { id, patch }),
    remove: (id: number) => ipcRenderer.invoke(IPC.CredentialsRemove, id),
    reveal: (id: number) => ipcRenderer.invoke(IPC.CredentialsReveal, id),
  },
  secret: {
    copy: (kind: SecretCopyKind, id?: string) => ipcRenderer.invoke(IPC.SecretCopy, { kind, id }),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke(IPC.OpenExternal, url),
    openBrowser: (url?: string) => ipcRenderer.invoke(IPC.BrowserOpen, url),
  },
  scans: {
    start: (programId: string, opts) => ipcRenderer.invoke(IPC.ScanStart, { programId, ...opts }),
    list: (programId: string) => ipcRenderer.invoke(IPC.ScanList, programId),
    listAll: (limit?: number) => ipcRenderer.invoke(IPC.ScanListAll, limit),
    events: (scanId: number, afterSeq: number) => ipcRenderer.invoke(IPC.ScanEvents, { scanId, afterSeq }),
    stop: (scanId: number) => ipcRenderer.invoke(IPC.ScanStop, scanId),
    remove: (scanId: number) => ipcRenderer.invoke(IPC.ScanRemove, scanId),
  },
  findings: {
    list: (query) => ipcRenderer.invoke(IPC.FindingsList, query),
    stats: (programId?: string) => ipcRenderer.invoke(IPC.FindingsStats, programId),
    create: (input) => ipcRenderer.invoke(IPC.FindingsCreate, input),
    update: (id: number, patch) => ipcRenderer.invoke(IPC.FindingsUpdate, { id, patch }),
    remove: (id: number) => ipcRenderer.invoke(IPC.FindingsRemove, id),
  },
  reports: {
    list: () => ipcRenderer.invoke(IPC.ReportsList),
    read: (relativePath: string) => ipcRenderer.invoke(IPC.ReportsRead, relativePath),
    openFolder: (relativePath?: string) => ipcRenderer.invoke(IPC.ReportsOpenFolder, relativePath),
    open: (programId: string, name: string) =>
      ipcRenderer.invoke(IPC.ReportsOpen, { programId, name }),
    reveal: (programId: string, name: string) =>
      ipcRenderer.invoke(IPC.ReportsReveal, { programId, name }),
  },
  tools: {
    list: () => ipcRenderer.invoke(IPC.ToolsList),
    install: (id: string) => ipcRenderer.invoke(IPC.ToolsInstall, id),
    onInstallOutput: (cb) => {
      const listener = (_e: unknown, payload: ToolInstallOutput): void => cb(payload)
      ipcRenderer.on(IPC.ToolsInstallOutput, listener)
      return () => ipcRenderer.removeListener(IPC.ToolsInstallOutput, listener)
    },
    githubTokenStatus: () => ipcRenderer.invoke(IPC.ToolsGitHubTokenGet),
    githubTokenSet: (token: string) => ipcRenderer.invoke(IPC.ToolsGitHubTokenSet, token),
    githubTokenClear: () => ipcRenderer.invoke(IPC.ToolsGitHubTokenClear),
  },
  mcp: {
    status: () => ipcRenderer.invoke(IPC.McpStatus),
    setEnabled: (enabled: boolean, opts?: { port?: number | null; lan?: boolean }) =>
      ipcRenderer.invoke(IPC.McpSetEnabled, { enabled, port: opts?.port ?? null, lan: opts?.lan }),
    regenerateToken: () => ipcRenderer.invoke(IPC.McpRegenerateToken),
    addToken: (label: string) => ipcRenderer.invoke(IPC.McpTokenAdd, { label }),
    revokeToken: (id: string) => ipcRenderer.invoke(IPC.McpTokenRevoke, { id }),
    requests: (limit?: number) => ipcRenderer.invoke(IPC.McpRequests, { limit: limit ?? null }),
    diagnose: () => ipcRenderer.invoke(IPC.McpDiagnose),
    firewallFix: () => ipcRenderer.invoke(IPC.McpFirewallFix),
    machines: (limit?: number) => ipcRenderer.invoke(IPC.McpMachines, { limit: limit ?? null }),
    pairingCreate: () => ipcRenderer.invoke(IPC.McpPairingCreate),
    pairingCancel: () => ipcRenderer.invoke(IPC.McpPairingCancel),
  },
  agent: {
    tokens: () => ipcRenderer.invoke(IPC.AgentTokens),
    addToken: (label: string) => ipcRenderer.invoke(IPC.AgentTokenAdd, { label }),
    revokeToken: (id: string) => ipcRenderer.invoke(IPC.AgentTokenRevoke, { id }),
    statuses: () => ipcRenderer.invoke(IPC.AgentStatuses),
    sessions: () => ipcRenderer.invoke(IPC.AgentSessions),
    sessionRequest: (tokenId: string) => ipcRenderer.invoke(IPC.AgentSessionRequest, { tokenId }),
    sessionDecide: (sessionId: number, approve: boolean) =>
      ipcRenderer.invoke(IPC.AgentSessionDecide, { sessionId, approve }),
    sessionEnd: (viewToken: string) => ipcRenderer.invoke(IPC.AgentSessionEnd, { viewToken }),
    viewToken: () => ipcRenderer.invoke(IPC.AgentViewToken),
  },
  favorites: {
    set: (programId: string, favorite: boolean) =>
      ipcRenderer.invoke(IPC.FavoriteSet, { programId, favorite }),
  },
  notes: {
    set: (programId: string, note: string) =>
      ipcRenderer.invoke(IPC.NoteSet, { programId, note }),
  },
  groups: {
    list: () => ipcRenderer.invoke(IPC.GroupsList),
    create: (name: string) => ipcRenderer.invoke(IPC.GroupsCreate, name),
    rename: (id: number, name: string) => ipcRenderer.invoke(IPC.GroupsRename, { id, name }),
    remove: (id: number) => ipcRenderer.invoke(IPC.GroupsRemove, id),
    addMember: (groupId: number, programId: string) =>
      ipcRenderer.invoke(IPC.GroupsAddMember, { groupId, programId }),
    removeMember: (groupId: number, programId: string) =>
      ipcRenderer.invoke(IPC.GroupsRemoveMember, { groupId, programId }),
  },
  tags: {
    list: () => ipcRenderer.invoke(IPC.TagsList),
    create: (name: string) => ipcRenderer.invoke(IPC.TagsCreate, name),
    remove: (id: number) => ipcRenderer.invoke(IPC.TagsRemove, id),
    addToProgram: (programId: string, tagId: number) =>
      ipcRenderer.invoke(IPC.TagsAddToProgram, { programId, tagId }),
    removeFromProgram: (programId: string, tagId: number) =>
      ipcRenderer.invoke(IPC.TagsRemoveFromProgram, { programId, tagId }),
  },
}

contextBridge.exposeInMainWorld('bountydesk', bridge)