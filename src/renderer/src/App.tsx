import { useEffect, useState, type ReactNode } from 'react'
import { Api } from './api'
import { LoginScreen } from './screens/Login'
import { ProgramsScreen } from './screens/Programs'
import { ToolsScreen } from './screens/Tools'
import { McpScreen } from './screens/Mcp'
import { ScansScreen } from './screens/Scans'
import { SettingsScreen } from './screens/Settings'

type View = 'loading' | 'login' | 'app'

export type Section = 'programs' | 'scans' | 'tools' | 'mcp' | 'settings'

const icon = {
  programs: (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path
        d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  ),
  tools: (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path
        d="M14.8 6.2a3.8 3.8 0 0 0-5.1 5.1L4 17v3h3l5.7-5.7a3.8 3.8 0 0 0 5.1-5.1l-2.5 2.5-2.4-.7-.7-2.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  ),
  scans: (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.7" opacity="0.6" />
      <path d="M12 12l5.2-5.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </svg>
  ),
  mcp: (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path
        d="M10.5 4l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5zM17.5 14l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path d="M4 7.5h8M17 7.5h3M4 16.5h3M12 16.5h8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="14.5" cy="7.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="9.5" cy="16.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path
        d="M12 3.5l7 2.8v4.9c0 4.4-2.9 8-7 9.8-4.1-1.8-7-5.4-7-9.8V6.3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  ),
  logout: (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path d="M12 3.5v7M8.2 6.2a6.2 6.2 0 1 0 7.6 0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
} satisfies Record<string, ReactNode>

const NAV: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'programs', label: 'Programmes', icon: icon.programs },
  { id: 'scans', label: 'Scans', icon: icon.scans },
  { id: 'tools', label: 'Outils', icon: icon.tools },
  { id: 'mcp', label: 'Assistant', icon: icon.mcp },
  { id: 'settings', label: 'Réglages', icon: icon.settings }
]

export function App() {
  const [view, setView] = useState<View>('loading')
  const [section, setSection] = useState<Section>('programs')
  // Les écrans visités restent montés : changer de section devient instantané,
  // et filtres/scroll/états locaux survivent aux allers-retours.
  const [visited, setVisited] = useState<Section[]>(['programs'])
  const [statusCheck, setStatusCheck] = useState(0)
  const [statusError, setStatusError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setStatusError(false)
    void Api.auth.status()
      .then((status) => {
        if (!cancelled) setView(status.configured ? 'app' : 'login')
      })
      .catch(() => {
        // Sans ce catch, un rejet IPC laisserait l'écran figé sur « Chargement… ».
        if (!cancelled) setStatusError(true)
      })
    return () => {
      cancelled = true
    }
  }, [statusCheck])

  const logout = (): void => {
    void Api.auth.logout()
    setView('login')
  }

  const goto = (id: Section): void => {
    setSection(id)
    setVisited((v) => (v.includes(id) ? v : [...v, id]))
  }

  if (view === 'loading') {
    return (
      <div className="splash">
        <span className="brand-mark pulse">◮</span>
        <span className="brand-name">Venari</span>
        {statusError ? (
          <div style={{ textAlign: 'center' }}>
            <p>Impossible de vérifier la session locale.</p>
            <button className="btn primary" onClick={() => setStatusCheck((n) => n + 1)}>
              Réessayer
            </button>
          </div>
        ) : (
          <p className="muted">Chargement…</p>
        )}
      </div>
    )
  }

  if (view === 'login') {
    return <LoginScreen onLoggedIn={() => setView('app')} />
  }

  const renderSection = (id: Section): ReactNode => {
    switch (id) {
      case 'programs':
        return <ProgramsScreen />
      case 'scans':
        return <ScansScreen />
      case 'tools':
        return <ToolsScreen />
      case 'mcp':
        return <McpScreen />
      case 'settings':
        return <SettingsScreen onLogout={logout} />
    }
  }

  return (
    <div className="app">
      <aside className="app-sidebar">
        <div className="app-brand">
          <span className="brand-mark">◮</span>
          <span className="brand-name">Venari</span>
        </div>
        <nav className="nav" aria-label="Navigation principale">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${section === item.id ? 'active' : ''}`}
              aria-current={section === item.id ? 'page' : undefined}
              title={item.label}
              onClick={() => goto(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="app-sidebar-foot">
          <button className="nav-item" onClick={() => goto('settings')} title="Sécurité & réglages">
            <span className="nav-icon">{icon.shield}</span>
            <span className="nav-label">Sécurité</span>
          </button>
          <button className="nav-item" onClick={logout} title="Se déconnecter">
            <span className="nav-icon">{icon.logout}</span>
            <span className="nav-label">Se déconnecter</span>
          </button>
        </div>
      </aside>
      <main className="app-main">
        {visited.map((id) => (
          <div key={id} className={`screen ${section === id ? '' : 'screen-hidden'}`} aria-hidden={section !== id}>
            {renderSection(id)}
          </div>
        ))}
      </main>
    </div>
  )
}
