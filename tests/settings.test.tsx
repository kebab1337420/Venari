// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { McpStatusInfo } from '../src/shared/ipc'

const api = vi.hoisted(() => ({
  auth: { status: vi.fn() },
  secret: { copy: vi.fn() },
  mcp: {
    status: vi.fn(),
    requests: vi.fn(),
    diagnose: vi.fn(),
    machines: vi.fn(),
    setEnabled: vi.fn(),
    regenerateToken: vi.fn(),
    firewallFix: vi.fn(),
    addToken: vi.fn(),
    revokeToken: vi.fn(),
    pairingCreate: vi.fn(),
    pairingCancel: vi.fn(),
  },
  agent: {
    statuses: vi.fn(),
    tokens: vi.fn(),
    sessions: vi.fn(),
    sessionRequest: vi.fn(),
    sessionDecide: vi.fn(),
    addToken: vi.fn(),
    revokeToken: vi.fn(),
  },
}))

vi.mock('../src/renderer/src/api', () => ({ Api: api }))

import { SettingsScreen } from '../src/renderer/src/screens/Settings'

afterEach(cleanup)

const status: McpStatusInfo = {
  enabled: true,
  running: true,
  port: 8787,
  lan: false,
  hosts: [],
  masked: 'mcp_••••',
  tokens: [{ id: 't1', label: 'PC-bureau', masked: 'mcp_••••abcd' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  api.auth.status.mockResolvedValue({ configured: true, keyring: true })
  api.mcp.status.mockResolvedValue(status)
  api.mcp.requests.mockResolvedValue({ ok: true, rows: [] })
  api.mcp.diagnose.mockResolvedValue({
    ok: true,
    diag: { running: true, port: 8787, lan: false, firewall: 'ok', selfTest: null, recentErrors: [] },
  })
  api.mcp.machines.mockResolvedValue({ ok: true, machines: [] })
  api.agent.statuses.mockResolvedValue({ ok: true, agents: [] })
  api.agent.tokens.mockResolvedValue({ ok: true, tokens: [] })
  api.agent.sessions.mockResolvedValue({ ok: true, sessions: [] })
})

describe('SettingsScreen — copie de secret', () => {
  it('signale un rejet IPC au lieu de laisser croire a une copie', async () => {
    api.secret.copy.mockRejectedValue(new Error('pont IPC coupe'))
    render(<SettingsScreen onLogout={vi.fn()} />)

    fireEvent.click(await screen.findByTitle('Copier le jeton'))

    expect(await screen.findByText('pont IPC coupe')).toBeTruthy()
  })

  it('affiche le message metier quand la copie est refusee', async () => {
    api.secret.copy.mockResolvedValue({ ok: false, error: 'Presse-papier indisponible.' })
    render(<SettingsScreen onLogout={vi.fn()} />)

    fireEvent.click(await screen.findByTitle('Copier le jeton'))

    expect(await screen.findByText('Presse-papier indisponible.')).toBeTruthy()
    expect(api.secret.copy).toHaveBeenCalledWith('mcpToken', 't1')
  })

  it('confirme la copie quand elle reussit', async () => {
    api.secret.copy.mockResolvedValue({ ok: true })
    render(<SettingsScreen onLogout={vi.fn()} />)

    fireEvent.click(await screen.findByTitle('Copier le jeton'))

    expect(await screen.findByText('✓')).toBeTruthy()
    expect(screen.queryByText('pont IPC coupe')).toBeNull()
  })

  it('protege aussi la copie de la configuration', async () => {
    api.secret.copy.mockRejectedValue(new Error('verrou'))
    render(<SettingsScreen onLogout={vi.fn()} />)

    // Deux boutons « Copier la config » (MCP et agent) : on vise la config MCP.
    fireEvent.click((await screen.findAllByText('Copier la config'))[0]!)

    expect(await screen.findByText('verrou')).toBeTruthy()
    expect(api.secret.copy).toHaveBeenCalledWith('agentConfig', undefined)
  })
})
