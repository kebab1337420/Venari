export const IPC = {
  AuthStatus: 'auth:status',
  AuthValidate: 'auth:validate',
  AuthClear: 'auth:clear',
  AppVersion: 'app:version',
  ProgramsList: 'programs:list',
  ProgramsSync: 'programs:sync',
  ProgramsExport: 'programs:export',
  FavoriteSet: 'favorite:set',
  NoteSet: 'note:set',
  GroupsList: 'groups:list',
  GroupsCreate: 'groups:create',
  GroupsRename: 'groups:rename',
  GroupsRemove: 'groups:remove',
  GroupsAddMember: 'groups:addMember',
  GroupsRemoveMember: 'groups:removeMember',
  TagsList: 'tags:list',
  TagsCreate: 'tags:create',
  TagsRemove: 'tags:remove',
  TagsAddToProgram: 'tags:addToProgram',
  TagsRemoveFromProgram: 'tags:removeFromProgram',
  ProgramDetailGet: 'programs:detail',
  CredentialsList: 'credentials:list',
  CredentialsAdd: 'credentials:add',
  CredentialsUpdate: 'credentials:update',
  CredentialsRemove: 'credentials:remove',
  CredentialsReveal: 'credentials:reveal',
  OpenExternal: 'shell:openExternal',
  BrowserOpen: 'browser:open',
  ScanStart: 'scan:start',
  ScanList: 'scan:list',
  ScanListAll: 'scan:listAll',
  ScanEvents: 'scan:events',
  ScanStop: 'scan:stop',
  ScanRemove: 'scan:remove',
  FindingsList: 'findings:list',
  FindingsStats: 'findings:stats',
  FindingsCreate: 'findings:create',
  FindingsUpdate: 'findings:update',
  FindingsRemove: 'findings:remove',
  ReportsList: 'reports:list',
  ReportsRead: 'reports:read',
  ReportsOpen: 'reports:open',
  ReportsReveal: 'reports:reveal',
  ReportsOpenFolder: 'reports:openFolder',
  ToolsList: 'tools:list',
  ToolsInstall: 'tools:install',
  ToolsInstallOutput: 'tools:install:output',
  ToolsGitHubTokenGet: 'tools:githubToken:get',
  ToolsGitHubTokenSet: 'tools:githubToken:set',
  ToolsGitHubTokenClear: 'tools:githubToken:clear',
  McpStatus: 'mcp:status',
  McpSetEnabled: 'mcp:setEnabled',
  McpRegenerateToken: 'mcp:regenerateToken',
  McpTokenAdd: 'mcp:tokenAdd',
  McpTokenRevoke: 'mcp:tokenRevoke',
  McpRequests: 'mcp:requests',
  McpDiagnose: 'mcp:diagnose',
  McpFirewallFix: 'mcp:firewallFix',
  McpMachines: 'mcp:machines',
  McpPairingCreate: 'mcp:pairingCreate',
  McpPairingCancel: 'mcp:pairingCancel',
  AgentTokens: 'agent:tokens',
  AgentTokenAdd: 'agent:tokenAdd',
  AgentTokenRevoke: 'agent:tokenRevoke',
  AgentStatuses: 'agent:statuses',
  AgentSessions: 'agent:sessions',
  AgentSessionRequest: 'agent:sessionRequest',
  AgentSessionDecide: 'agent:sessionDecide',
  AgentSessionEnd: 'agent:sessionEnd',
  AgentViewToken: 'agent:viewToken',
  SecretCopy: 'secret:copy',
} as const

export interface AuthStatus {
  configured: boolean
  /** true = secrets protégés par le trousseau du système, false = repli AES-GCM local. */
  keyring: boolean
}

export interface AuthValidateResult {
  ok: boolean
  error?: string
}

export interface ProgramSummary {
  id: string
  handle: string
  name: string
  type: string | null
  status: string | null
  confidentiality: string | null
  minBounty: { value: number; currency: string } | null
  maxBounty: { value: number; currency: string } | null
  industry: string | null
  webLink: string | null
  following: boolean
  favorite: boolean
  note: string
  tags: string[]
  groups: string[]
  updatedAt: number
}

export interface ProgramsQuery {
  search?: string
  favoriteOnly?: boolean
  groupId?: number
  tagId?: number
  sort?: 'name' | 'bounty' | 'recent'
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface ProgramsPage {
  records: ProgramSummary[]
  total: number
}

export type ExportFormat = 'csv' | 'json' | 'md'

/**
 * L'export se fait via un sélecteur de fichier du système : le renderer ne
 * choisit jamais un chemin, il ne reçoit que le chemin retenu.
 * `canceled` distingue l'annulation (pas une erreur à afficher) d'un échec.
 */
export type ProgramsExportResult =
  | { ok: true; path: string; rows: number }
  | { ok: false; error: string; canceled?: boolean }

export type DbFail = { ok: false; error: string }

export type DbResult = { ok: true } | DbFail

export type SyncResult = { ok: true; synced: number; at: number } | DbFail

export type CreateGroupResult = { ok: true; group: { id: number } } | DbFail

export type CreateTagResult = { ok: true; tag: { id: number } } | DbFail

export interface GroupInfo {
  id: number
  name: string
  color: string | null
  memberCount: number
}

export interface TagInfo {
  id: number
  name: string
  count: number
}

export interface MoneyInfo {
  value: number
  currency: string
}

export interface ScopeDomain {
  id: string
  type: string
  endpoint: string
  tier: string
  description: string
  inScope: boolean
}

export interface RoeInfo {
  description: string
  intigritiMe: boolean
  automatedTooling: number | null
  userAgent: string | null
  requestHeader: string | null
  safeHarbour: boolean
  attachments: { url: string; code: number }[]
}

export interface ScopeChangeItem {
  endpoint: string
  inScope: boolean
}

/** Cibles apparues ou disparues depuis la derniere consultation du scope. */
export interface ScopeChangeSummary {
  added: ScopeChangeItem[]
  removed: ScopeChangeItem[]
}

export interface ProgramDetailData {
  programId: string
  handle: string
  name: string
  status: string | null
  type: string | null
  confidentiality: string | null
  industry: string | null
  webLink: string | null
  minBounty: MoneyInfo | null
  maxBounty: MoneyInfo | null
  scope: ScopeDomain[]
  roe: RoeInfo | null
  fetchedAt: number
  /**
   * `null` au premier rafraichissement (aucune reference) et quand rien n'a
   * bouge. Absent du cache hors ligne, qui ne recalcule pas de diff.
   */
  scopeChanges?: ScopeChangeSummary | null
}

export interface CredentialRecord {
  id: number
  programId: string
  label: string
  username: string
  hasSecret: boolean
  note: string
  updatedAt: number
}

export interface CredentialInput {
  programId: string
  label: string
  username: string
  secret: string
  note: string
}

export type DetailResult = { ok: true; detail: ProgramDetailData } | DbFail

export type CredentialsListResult = { ok: true; credentials: CredentialRecord[] } | DbFail

export type CredentialSaveResult = { ok: true; id: number } | DbFail

export type OpenExternalResult = { ok: boolean; error?: string }

export type ScanDepth = 'low' | 'med' | 'high'

export interface ScanRecord {
  id: number
  programId: string
  depth: ScanDepth
  status: string
  rateLimit: number
  roeConfirm: boolean
  startedAt: number
  finishedAt: number | null
}

export interface ScanEvent {
  seq: number
  ts: number
  level: string
  message: string
}

export type ScanStartResult = { ok: true; scanId: number } | DbFail

export type ScanListResult = { ok: true; scans: ScanRecord[] } | DbFail

/** Scan + identite du programme : le tableau de bord est global, pas filtre. */
export interface ScanOverview extends ScanRecord {
  programName: string
  programHandle: string
}

export type ScanListAllResult = { ok: true; scans: ScanOverview[] } | DbFail

export type ScanEventsResult = { ok: true; events: ScanEvent[]; done: boolean } | DbFail

export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

export const FINDING_STATUSES = ['open', 'triaged', 'reported', 'fixed', 'duplicate', 'wontfix'] as const

export type FindingStatus = (typeof FINDING_STATUSES)[number]

export interface FindingRecord {
  id: number
  programId: string
  programName: string
  asset: string
  title: string
  severity: FindingSeverity
  cvss: number | null
  status: FindingStatus
  description: string
  poc: string
  reportPath: string | null
  scanId: number | null
  createdAt: number
  updatedAt: number
}

export interface FindingInput {
  programId: string
  asset: string
  title: string
  severity: FindingSeverity
  cvss: number | null
  status: FindingStatus
  description: string
  poc: string
  reportPath: string | null
  scanId: number | null
}

export interface FindingsQuery {
  programId?: string
  status?: FindingStatus
  severity?: FindingSeverity
  search?: string
  limit?: number
  offset?: number
}

export type FindingsListResult = { ok: true; findings: FindingRecord[] } | DbFail

export type FindingsStatsResult = { ok: true; stats: Record<string, number> } | DbFail

export type FindingSaveResult = { ok: true; id: number } | DbFail


export type ReportReadResult = { ok: true; content: string; truncated: boolean } | DbFail

export interface ToolEntry {
  id: string
  name: string
  description: string
  category: string
  source: 'winget' | 'github' | 'git' | 'pip' | 'go'
  installed: boolean
  defaultChecked: boolean
  docs?: string
  /** Windows uniquement : l'app refuse l'installation ailleurs (badge + message). */
  windowsOnly?: boolean
  /** Application graphique : rien d'installable en ligne de commande. */
  guiOnly?: boolean
}

export type ToolsListResult = { ok: true; tools: ToolEntry[] } | DbFail

export type ToolInstallResult = { ok: true; installed: boolean; output: string } | { ok: false; error: string; output: string }

/** Ligne d'une installation, émise au fil de l'eau pendant qu'elle tourne. */
export type ToolInstallOutput = { id: string; line: string }

export type GitHubTokenStatusResult = { ok: true; configured: boolean } | DbFail

export type GitHubTokenSetResult = { ok: true } | DbFail

/**
 * Les jetons ne traversent jamais IPC en clair : le renderer recoit un
 * masque, et la copie se fait dans le processus principal.
 */
export interface McpTokenInfo {
  id: string
  label: string
  masked: string
}

export interface McpStatusInfo {
  enabled: boolean
  running: boolean
  port: number | null
  lan: boolean
  hosts: string[]
  masked: string
  tokens: McpTokenInfo[]
}

export type McpSetEnabledResult = { ok: true; status: McpStatusInfo } | DbFail

export type McpRegenerateResult = { ok: true; id: string; masked: string; status: McpStatusInfo } | DbFail

export type McpTokenAddResult = { ok: true; id: string; masked: string; status: McpStatusInfo } | DbFail

export type McpTokenRevokeResult = { ok: true; status: McpStatusInfo } | DbFail

export interface McpRequestRow {
  id: number
  ts: number
  tokenLabel: string
  tool: string
  args: string
  status: string
  ms: number
  remoteIp: string
}

export type McpRequestsResult = { ok: true; rows: McpRequestRow[] } | DbFail

export interface McpMachineInfo {
  tokenLabel: string
  lastSeen: number
  calls: number
  errors: number
  ips: string[]
}

export type McpMachinesResult = { ok: true; machines: McpMachineInfo[] } | DbFail

export type McpFirewallState = 'ok' | 'missing' | 'unmanaged'

export interface McpDiagnoseInfo {
  running: boolean
  port: number | null
  lan: boolean
  firewall: McpFirewallState
  selfTest: { ok: boolean; ms: number | null; error?: string } | null
  recentErrors: McpRequestRow[]
}

export type McpDiagnoseResult = { ok: true; diag: McpDiagnoseInfo } | DbFail

export type McpFirewallFixResult = { ok: true; firewall: McpFirewallState } | DbFail

/** Code d'appairage a usage unique, montre a l'humain qui le dicte au poste a connecter. */
export interface McpPairingInfo {
  code: string
  expiresAt: number
  pairId: string
  port: number | null
  lan: boolean
  hosts: string[]
}

export type McpPairingCreateResult = { ok: true; pairing: McpPairingInfo } | DbFail

export type McpPairingCancelResult = DbResult

export interface AgentTokenInfo {
  id: string
  label: string
  masked: string
}

export interface AgentStatusInfo {
  id: string
  label: string
  online: boolean
  hostname: string
  ip: string
  lastSeen: number | null
  streaming: boolean
  latency: number | null
  activeSession: number | null
}

export interface RemoteSessionInfo {
  id: number
  agentLabel: string
  remoteIp: string
  status: 'pending' | 'active' | 'refused' | 'ended'
  width: number | null
  height: number | null
  requestedAt: number
  decidedAt: number | null
  endedAt: number | null
}

export type AgentTokensResult = { ok: true; port: number | null; hosts: string[]; tokens: AgentTokenInfo[] } | DbFail

export type AgentTokenAddResult =
  | { ok: true; id: string; masked: string; port: number | null; hosts: string[]; tokens: AgentTokenInfo[] }
  | DbFail

export type AgentTokenRevokeResult = { ok: true; port: number | null; hosts: string[]; tokens: AgentTokenInfo[] } | DbFail

export type AgentStatusesResult = { ok: true; agents: AgentStatusInfo[] } | DbFail

export type AgentSessionsResult = { ok: true; sessions: RemoteSessionInfo[] } | DbFail

export type AgentSessionRequestResult = { ok: true; session: RemoteSessionInfo | null } | DbFail

export type AgentSessionDecideResult = { ok: true; session: RemoteSessionInfo } | DbFail

export type AgentViewTokenResult = { ok: true; token: string } | DbFail

/**
 * Copie un secret dans le presse-papier depuis le processus principal.
 * Le renderer ne peut choisir que *quel* secret copier, jamais une valeur
 * arbitraire : c'est lui qui connait le contenu, le renderer ne le voit pas.
 */
export type SecretCopyKind = 'mcpToken' | 'agentToken' | 'mcpConfig' | 'agentConfig'

export type SecretCopyResult = { ok: true } | DbFail
export type AppVersionResult = { ok: true; version: string; name: string } | DbFail

export type CredentialRevealResult = { ok: true; secret: string } | DbFail

/** Rapport Markdown ecrit par `submit_report` (dossier de donnees Venari). */
export interface ReportFile {
  programId: string
  name: string
  path: string
  size: number
  updatedAt: number
}

export type ReportsListResult = { ok: true; reports: ReportFile[] } | DbFail

export type ReportOpenResult = { ok: boolean; error?: string }

export interface BountyDeskBridge {
  auth: {
    getStatus(): Promise<AuthStatus>
    validate(token: string): Promise<AuthValidateResult>
    clear(): Promise<void>
  }
  app: {
    version(): Promise<AppVersionResult>
  }
  programs: {
    list(query: ProgramsQuery): Promise<ProgramsPage>
    sync(): Promise<SyncResult>
    detail(programId: string): Promise<DetailResult>
    export(query: ProgramsQuery, format: ExportFormat): Promise<ProgramsExportResult>
  }
  credentials: {
    list(programId: string): Promise<CredentialsListResult>
    add(input: CredentialInput): Promise<CredentialSaveResult>
    update(id: number, patch: Partial<CredentialInput>): Promise<DbResult>
    remove(id: number): Promise<DbResult>
    reveal(id: number): Promise<CredentialRevealResult>
  }
  secret: {
    copy(kind: SecretCopyKind, id?: string): Promise<SecretCopyResult>
  }
  shell: {
    openExternal(url: string): Promise<OpenExternalResult>
    openBrowser(url?: string): Promise<{ ok: boolean; error?: string }>
  }
  scans: {
    start(programId: string, opts: { depth: ScanDepth; roeConfirm: boolean; rateLimit?: number }): Promise<ScanStartResult>
    list(programId: string): Promise<ScanListResult>
    listAll(limit?: number): Promise<ScanListAllResult>
    events(scanId: number, afterSeq: number): Promise<ScanEventsResult>
    stop(scanId: number): Promise<DbResult>
    remove(scanId: number): Promise<DbResult>
  }
  findings: {
    list(query: FindingsQuery): Promise<FindingsListResult>
    stats(programId?: string): Promise<FindingsStatsResult>
    create(input: FindingInput): Promise<FindingSaveResult>
    update(id: number, patch: Partial<FindingInput>): Promise<DbResult>
    remove(id: number): Promise<DbResult>
  }
  reports: {
    list(): Promise<ReportsListResult>
    read(relativePath: string): Promise<ReportReadResult>
    openFolder(relativePath?: string): Promise<DbResult>
    open(programId: string, name: string): Promise<ReportOpenResult>
    reveal(programId: string, name: string): Promise<ReportOpenResult>
  }
  tools: {
    list(): Promise<ToolsListResult>
    install(id: string): Promise<ToolInstallResult>
    onInstallOutput(cb: (payload: ToolInstallOutput) => void): () => void
    githubTokenStatus(): Promise<GitHubTokenStatusResult>
    githubTokenSet(token: string): Promise<GitHubTokenSetResult>
    githubTokenClear(): Promise<DbResult>
  }
  mcp: {
    status(): Promise<McpStatusInfo>
    setEnabled(enabled: boolean, opts?: { port?: number | null; lan?: boolean }): Promise<McpSetEnabledResult>
    regenerateToken(): Promise<McpRegenerateResult>
    addToken(label: string): Promise<McpTokenAddResult>
    revokeToken(id: string): Promise<McpTokenRevokeResult>
    requests(limit?: number): Promise<McpRequestsResult>
    diagnose(): Promise<McpDiagnoseResult>
    firewallFix(): Promise<McpFirewallFixResult>
    machines(limit?: number): Promise<McpMachinesResult>
    pairingCreate(): Promise<McpPairingCreateResult>
    pairingCancel(): Promise<McpPairingCancelResult>
  }
  agent: {
    tokens(): Promise<AgentTokensResult>
    addToken(label: string): Promise<AgentTokenAddResult>
    revokeToken(id: string): Promise<AgentTokenRevokeResult>
    statuses(): Promise<AgentStatusesResult>
    sessions(): Promise<AgentSessionsResult>
    sessionRequest(tokenId: string): Promise<AgentSessionRequestResult>
    sessionDecide(sessionId: number, approve: boolean): Promise<AgentSessionDecideResult>
    sessionEnd(viewToken: string): Promise<DbResult>
    viewToken(): Promise<AgentViewTokenResult>
  }
  favorites: {
    set(programId: string, favorite: boolean): Promise<DbResult>
  }
  notes: {
    set(programId: string, note: string): Promise<DbResult>
  }
  groups: {
    list(): Promise<GroupInfo[]>
    create(name: string): Promise<CreateGroupResult>
    rename(id: number, name: string): Promise<DbResult>
    remove(id: number): Promise<DbResult>
    addMember(groupId: number, programId: string): Promise<DbResult>
    removeMember(groupId: number, programId: string): Promise<DbResult>
  }
  tags: {
    list(): Promise<TagInfo[]>
    create(name: string): Promise<CreateTagResult>
    remove(id: number): Promise<DbResult>
    addToProgram(programId: string, tagId: number): Promise<DbResult>
    removeFromProgram(programId: string, tagId: number): Promise<DbResult>
  }
}