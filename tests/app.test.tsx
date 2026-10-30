// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({
  auth: { status: vi.fn(), logout: vi.fn() },
}))

vi.mock('../src/renderer/src/api', () => ({ Api: api }))

// Les ecrans sont remplaces par des balises : on teste l'aiguillage et l'etat
// de l'App, pas le contenu des ecrans (couverts separement).
vi.mock('../src/renderer/src/screens/Login', () => ({
  LoginScreen: ({ onLoggedIn }: { onLoggedIn: () => void }) => (
    <div>
      ECRAN-LOGIN
      <button onClick={onLoggedIn}>Entrer</button>
    </div>
  ),
}))
vi.mock('../src/renderer/src/screens/Programs', () => ({ ProgramsScreen: () => <div>ECRAN-PROGRAMMES</div> }))
vi.mock('../src/renderer/src/screens/Tools', () => ({ ToolsScreen: () => <div>ECRAN-OUTILS</div> }))
vi.mock('../src/renderer/src/screens/Mcp', () => ({ McpScreen: () => <div>ECRAN-MCP</div> }))
vi.mock('../src/renderer/src/screens/Settings', () => ({
  SettingsScreen: ({ onLogout }: { onLogout: () => void }) => (
    <div>
      ECRAN-REGLAGES
      <button onClick={onLogout}>Sortir</button>
    </div>
  ),
}))

import { App } from '../src/renderer/src/App'

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  api.auth.status.mockResolvedValue({ configured: true, keyring: true })
  api.auth.logout.mockResolvedValue({ ok: true })
})

describe('App — amorcage', () => {
  it('affiche le splash tant que le statut est inconnu', () => {
    api.auth.status.mockReturnValue(new Promise(() => {}))
    render(<App />)
    expect(screen.getByText('Chargement…')).toBeTruthy()
  })

  it('ouvre l application quand la session est configuree', async () => {
    render(<App />)
    expect(await screen.findByText('ECRAN-PROGRAMMES')).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeTruthy()
  })

  it('affiche l ecran de connexion quand aucun jeton n est configure', async () => {
    api.auth.status.mockResolvedValue({ configured: false, keyring: true })
    render(<App />)
    expect(await screen.findByText('ECRAN-LOGIN')).toBeTruthy()
  })

  it('bascule vers l application apres connexion', async () => {
    api.auth.status.mockResolvedValue({ configured: false, keyring: true })
    render(<App />)
    fireEvent.click(await screen.findByText('Entrer'))
    expect(await screen.findByText('ECRAN-PROGRAMMES')).toBeTruthy()
  })

  it('propose de reessayer quand le statut echoue', async () => {
    api.auth.status.mockRejectedValueOnce(new Error('IPC coupe'))
    render(<App />)
    expect(await screen.findByText('Impossible de vérifier la session locale.')).toBeTruthy()

    api.auth.status.mockResolvedValueOnce({ configured: true, keyring: true })
    fireEvent.click(screen.getByText('Réessayer'))
    expect(await screen.findByText('ECRAN-PROGRAMMES')).toBeTruthy()
    expect(api.auth.status).toHaveBeenCalledTimes(2)
  })
})

describe('App — navigation', () => {
  it('change de section et conserve les ecrans deja visites', async () => {
    render(<App />)
    await screen.findByText('ECRAN-PROGRAMMES')

    const tools = screen.getByRole('button', { name: 'Outils' })
    fireEvent.click(tools)
    expect(screen.getByText('ECRAN-OUTILS')).toBeTruthy()
    expect(tools.getAttribute('aria-current')).toBe('page')

    // L'ecran Programme reste monte (filtres/scroll conserves) mais masque.
    const programsScreen = screen.getByText('ECRAN-PROGRAMMES').closest('.screen')
    expect(programsScreen?.className).toContain('screen-hidden')
  })

  it('ouvre les reglages via le raccourci Securite', async () => {
    render(<App />)
    await screen.findByText('ECRAN-PROGRAMMES')
    fireEvent.click(screen.getByRole('button', { name: 'Sécurité' }))
    expect(screen.getByText('ECRAN-REGLAGES')).toBeTruthy()
  })
})

describe('App — deconnexion', () => {
  it('appelle logout et revient a l ecran de connexion', async () => {
    render(<App />)
    await screen.findByText('ECRAN-PROGRAMMES')
    fireEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }))

    expect(api.auth.logout).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('ECRAN-LOGIN')).toBeTruthy()
  })

  it('propage la deconnexion demandee depuis les reglages', async () => {
    render(<App />)
    await screen.findByText('ECRAN-PROGRAMMES')
    fireEvent.click(screen.getByRole('button', { name: 'Sécurité' }))
    fireEvent.click(screen.getByText('Sortir'))

    expect(api.auth.logout).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('ECRAN-LOGIN')).toBeTruthy()
  })
})
