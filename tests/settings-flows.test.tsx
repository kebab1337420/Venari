// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const baseStatus = (over: Partial<McpStatusInfo> = {}): McpStatusInfo => ({
  enabled: true,
  running: true,
  port: 8787,
  lan: false,
  hosts: [],
  masked: 'mcp_••••',
  tokens: [{ id: 't1', label: 'PC-bureau', masked: 'mcp_••••abcd' }],
  ...over,
})

const okStatus = (over: Partial<McpStatusInfo> = {}) => ({ ok: true, status: baseStatus(over) })

beforeEach(() => {
  vi.clearAllMocks()
  api.auth.status.mockResolvedValue({ configured: true, keyring: true })
  api.mcp.status.mockResolvedValue(baseStatus())
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

async function renderReady(): Promise<void> {
  render(<SettingsScreen onLogout={vi.fn()} />)
  await screen.findByLabelText(/Activer le serveur MCP/)
}

describe('SettingsScreen — serveur MCP', () => {
  it('desactive le serveur via la case a cocher', async () => {
    api.mcp.setEnabled.mockResolvedValue(okStatus({ enabled: false, running: false }))
    await renderReady()

    fireEvent.click(screen.getByLabelText(/Activer le serveur MCP/))

    expect(api.mcp.setEnabled).toHaveBeenCalledWith(false, { lan: false })
  })

  it('demande confirmation avant d exposer sur le LAN et respecte un refus', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    api.mcp.setEnabled.mockResolvedValue(okStatus({ lan: true }))
    await renderReady()

    fireEvent.click(screen.getByLabelText(/Exposer sur le réseau local/))

    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(api.mcp.setEnabled).not.toHaveBeenCalled()
  })

  it('active le LAN apres confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    api.mcp.setEnabled.mockResolvedValue(okStatus({ lan: true }))
    await renderReady()

    fireEvent.click(screen.getByLabelText(/Exposer sur le réseau local/))

    expect(api.mcp.setEnabled).toHaveBeenCalledWith(true, { lan: true })
  })

  it('regenere le jeton principal', async () => {
    api.mcp.regenerateToken.mockResolvedValue(okStatus({ tokens: [{ id: 't9', label: 'PC-bureau', masked: 'mcp_••••9999' }] }))
    await renderReady()

    fireEvent.click(screen.getByText('Régénérer le jeton principal'))

    expect(api.mcp.regenerateToken).toHaveBeenCalledTimes(1)
  })

  it('ajoute un jeton avec son libelle', async () => {
    api.mcp.addToken.mockResolvedValue(okStatus())
    await renderReady()

    fireEvent.change(screen.getByPlaceholderText(/Nom du poste \/ IA/), { target: { value: 'Labo' } })
    fireEvent.click(screen.getByText('+ Ajouter un jeton'))

    expect(api.mcp.addToken).toHaveBeenCalledWith('Labo')
  })

  it('revoque un jeton apres confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    api.mcp.status.mockResolvedValue(
      baseStatus({
        tokens: [
          { id: 't1', label: 'PC-bureau', masked: 'mcp_••••abcd' },
          { id: 't2', label: 'Labo', masked: 'mcp_••••efgh' },
        ],
      })
    )
    api.mcp.revokeToken.mockResolvedValue(okStatus())
    await renderReady()

    fireEvent.click(screen.getAllByTitle('Révoquer le jeton')[0]!)

    expect(api.mcp.revokeToken).toHaveBeenCalledWith('t1')
  })

  it('refuse de revoquer le dernier jeton actif', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderReady()

    fireEvent.click(screen.getByTitle('Révoquer le jeton'))

    expect(api.mcp.revokeToken).not.toHaveBeenCalled()
    expect(await screen.findByText('Au moins un jeton doit rester actif.')).toBeTruthy()
  })

  it('regenere un code d appairage puis l annule', async () => {
    api.mcp.pairingCreate.mockResolvedValue({
      ok: true,
      pairing: { code: 'ABC123', expiresAt: Date.now() + 60_000, pairId: 'pair-1', port: 8787 },
    })
    api.mcp.pairingCancel.mockResolvedValue({ ok: true })
    await renderReady()

    fireEvent.click(screen.getByText("Générer un code d'appairage"))
    expect(await screen.findByText('ABC123')).toBeTruthy()

    fireEvent.click(screen.getByText('Annuler'))
    expect(api.mcp.pairingCancel).toHaveBeenCalledTimes(1)
  })

  it('reparer le pare-feu relance le diagnostic', async () => {
    api.mcp.diagnose
      .mockResolvedValueOnce({
        ok: true,
        diag: { running: true, port: 8787, lan: true, firewall: 'missing', selfTest: null, recentErrors: [] },
      })
      .mockResolvedValue({
        ok: true,
        diag: { running: true, port: 8787, lan: true, firewall: 'ok', selfTest: null, recentErrors: [] },
      })
    api.mcp.firewallFix.mockResolvedValue({ ok: true, firewall: 'ok' })
    await renderReady()

    fireEvent.click(screen.getByText('Réparer (demande admin)'))

    expect(api.mcp.firewallFix).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText('Réparer (demande admin)')).toBeNull())
  })
})

describe('SettingsScreen — actualisation', () => {
  it('signale un echec de chargement du statut', async () => {
    api.mcp.status.mockRejectedValue(new Error('serveur injoignable'))
    render(<SettingsScreen onLogout={vi.fn()} />)

    expect(await screen.findByText('Actualisation impossible (serveur MCP injoignable ?).')).toBeTruthy()
  })
})
