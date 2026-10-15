// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { McpStatusInfo } from '../src/shared/ipc'
import { Api } from '../src/renderer/src/api'
import { McpScreen } from '../src/renderer/src/screens/Mcp'

// Pont preload absent de jsdom : seul le mappage etat -> affichage est teste ici.
vi.mock('../src/renderer/src/api', () => ({
  Api: { mcp: { status: vi.fn() }, shell: { openBrowser: vi.fn() } }
}))

afterEach(cleanup)

const status = vi.mocked(Api.mcp.status)
const openBrowser = vi.mocked(Api.shell.openBrowser)

function someStatus(overrides: Partial<McpStatusInfo> = {}): McpStatusInfo {
  return {
    enabled: true,
    running: false,
    port: 8787,
    lan: false,
    hosts: [],
    masked: '',
    tokens: [],
    ...overrides
  }
}

describe('McpScreen', () => {
  it("affiche un chargement tant que l'etat n'est pas arrive", () => {
    status.mockImplementation(() => new Promise<McpStatusInfo>(() => {}))

    render(<McpScreen />)

    expect(screen.getByText(/Chargement de l/)).toBeTruthy()
  })

  it('affiche un serveur actif avec son port et son nombre de jetons', async () => {
    status.mockResolvedValue(
      someStatus({
        running: true,
        tokens: [
          { id: 't1', label: 'agent', masked: '****' },
          { id: 't2', label: 'demo', masked: '****' }
        ]
      })
    )

    render(<McpScreen />)

    expect(await screen.findByText(/Serveur MCP actif sur le port 8787/)).toBeTruthy()
    expect(screen.getByText(/2 jeton\(s\)/)).toBeTruthy()
  })

  it('signale un serveur configure mais a larret', async () => {
    status.mockResolvedValue(someStatus({ running: false }))

    render(<McpScreen />)

    expect(await screen.findByText(/Serveur MCP configur/)).toBeTruthy()
  })

  it('signale un serveur desactive', async () => {
    status.mockResolvedValue(someStatus({ enabled: false }))

    render(<McpScreen />)

    expect(await screen.findByText(/activez-le/)).toBeTruthy()
  })

  it("signale un etat indisponible quand l'interrogation echoue", async () => {
    status.mockImplementation(() => Promise.reject(new Error('IPC indisponible')))

    render(<McpScreen />)

    expect(await screen.findByText(/indisponible/)).toBeTruthy()
  })

  it("affiche l'erreur renvoyee par l'ouverture du navigateur", async () => {
    status.mockResolvedValue(someStatus())
    openBrowser.mockResolvedValue({ ok: false, error: 'Ouverture impossible' })

    render(<McpScreen />)

    fireEvent.click(screen.getByRole('button'))

    expect(await screen.findByText('Ouverture impossible')).toBeTruthy()
    expect(openBrowser).toHaveBeenCalledTimes(1)
  })

  it("n'affiche aucune erreur quand le navigateur s'ouvre", async () => {
    status.mockResolvedValue(someStatus())
    openBrowser.mockResolvedValue({ ok: true })

    const { container } = render(<McpScreen />)

    fireEvent.click(screen.getByRole('button'))

    await screen.findByText(/Serveur MCP/)
    expect(container.querySelector('.muted-text')).toBeNull()
    expect(openBrowser).toHaveBeenCalledTimes(1)
  })
})
