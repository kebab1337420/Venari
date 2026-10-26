// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ToolEntry, ToolInstallOutput } from '../src/shared/ipc'
import { Api } from '../src/renderer/src/api'
import { ToolsScreen } from '../src/renderer/src/screens/Tools'

vi.mock('../src/renderer/src/api', () => ({
  Api: {
    tools: {
      list: vi.fn(),
      install: vi.fn(),
      onInstallOutput: vi.fn(),
      githubTokenStatus: vi.fn(),
      githubTokenSet: vi.fn(),
      githubTokenClear: vi.fn(),
    },
    shell: { openExternal: vi.fn() },
  },
}))

const list = vi.mocked(Api.tools.list)
const install = vi.mocked(Api.tools.install)
const onInstallOutput = vi.mocked(Api.tools.onInstallOutput)
const ghStatus = vi.mocked(Api.tools.githubTokenStatus)
const ghSet = vi.mocked(Api.tools.githubTokenSet)
const ghClear = vi.mocked(Api.tools.githubTokenClear)
const openExternal = vi.mocked(Api.shell.openExternal)

const tool = (over: Partial<ToolEntry> = {}): ToolEntry => ({
  id: 'nuclei',
  name: 'Nuclei',
  description: 'scanner de vulns',
  category: 'recon',
  source: 'github',
  installed: false,
  defaultChecked: false,
  ...over,
})

const subfinder = tool({ id: 'subfinder', name: 'Subfinder', description: 'enumeration de sous-domaines', category: 'enumer' })
const ffuf = tool({ id: 'ffuf', name: 'ffuf', description: 'fuzzing de chemins', category: 'fuzz' })

const searchBox = (): HTMLInputElement =>
  screen.getByPlaceholderText('Filtrer par nom, description ou catégorie…') as HTMLInputElement
const installButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /Installer la sélection/ }) as HTMLButtonElement
const onlyInstalled = (): HTMLInputElement =>
  screen.getByText('installés seulement').closest('label')!.querySelector('input') as HTMLInputElement

function toolCheckbox(name: string): HTMLInputElement {
  const label = screen.getByText(name).closest('label') as HTMLLabelElement
  return label.querySelector('input[type="checkbox"]') as HTMLInputElement
}

let emitOutput: ((payload: ToolInstallOutput) => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  emitOutput = null
  list.mockResolvedValue({ ok: true, tools: [tool(), subfinder, ffuf] })
  install.mockResolvedValue({ ok: true, installed: true, output: 'ok' })
  onInstallOutput.mockImplementation((cb) => {
    emitOutput = cb
    return () => undefined
  })
  ghStatus.mockResolvedValue({ ok: true, configured: false })
  ghSet.mockResolvedValue({ ok: true })
  ghClear.mockResolvedValue({ ok: true })
  openExternal.mockResolvedValue({ ok: true })
})

afterEach(cleanup)

describe('ToolsScreen', () => {
  it('charge et affiche les outils par categorie', async () => {
    render(<ToolsScreen />)
    expect(await screen.findByText('Nuclei')).toBeTruthy()
    expect(screen.getByText('Subfinder')).toBeTruthy()
    expect(screen.getByText('Reconnaissance')).toBeTruthy()
    expect(screen.getByText('Énumération')).toBeTruthy()
  })

  it('affiche une erreur et une liste vide si le chargement echoue', async () => {
    list.mockResolvedValue({ ok: false, error: 'db cassée' })
    render(<ToolsScreen />)
    expect(await screen.findByText('db cassée')).toBeTruthy()
    expect(screen.getByText('Liste des outils indisponible (voir ci-dessus).')).toBeTruthy()
  })

  it('filtre par recherche', async () => {
    render(<ToolsScreen />)
    await screen.findByText('Nuclei')
    fireEvent.change(searchBox(), { target: { value: 'fuzz' } })
    expect(screen.getByText('ffuf')).toBeTruthy()
    expect(screen.queryByText('Nuclei')).toBeNull()
    expect(screen.getByText('1/3')).toBeTruthy()
  })

  it('filtre sur les outils installes puis reinitialise', async () => {
    list.mockResolvedValue({ ok: true, tools: [tool({ installed: true }), subfinder] })
    render(<ToolsScreen />)
    await screen.findByText('Nuclei')
    fireEvent.click(onlyInstalled())
    expect(screen.getByText('Nuclei')).toBeTruthy()
    expect(screen.queryByText('Subfinder')).toBeNull()
    fireEvent.click(screen.getByText('Réinitialiser'))
    expect(screen.getByText('Subfinder')).toBeTruthy()
    expect(onlyInstalled().checked).toBe(false)
  })

  it('selectionne un outil individuellement', async () => {
    render(<ToolsScreen />)
    await screen.findByText('Nuclei')
    expect(installButton().disabled).toBe(true)
    fireEvent.click(toolCheckbox('Nuclei'))
    expect(installButton().disabled).toBe(false)
    expect(installButton().textContent).toContain('(1)')
  })

  it('selectionne puis deselectionne tout', async () => {
    render(<ToolsScreen />)
    await screen.findByText('Nuclei')
    fireEvent.click(screen.getByText('Tout sélectionner'))
    expect(installButton().textContent).toContain('(3)')
    fireEvent.click(screen.getByText('Tout désélectionner'))
    expect(installButton().disabled).toBe(true)
  })

  it('installe la selection et recharge', async () => {
    render(<ToolsScreen />)
    await screen.findByText('Nuclei')
    fireEvent.click(toolCheckbox('Nuclei'))
    fireEvent.click(installButton())

    await waitFor(() => expect(install).toHaveBeenCalledWith('nuclei'))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('affiche l echec d installation', async () => {
    install.mockResolvedValue({ ok: false, error: 'winget absent', output: '' })
    render(<ToolsScreen />)
    await screen.findByText('Nuclei')
    fireEvent.click(toolCheckbox('Nuclei'))
    fireEvent.click(installButton())
    expect(await screen.findByText('✕ winget absent')).toBeTruthy()
  })

  it('affiche la sortie en continu pendant l installation', async () => {
    let settle!: (r: Awaited<ReturnType<typeof install>>) => void
    install.mockReturnValue(new Promise((resolve) => {
      settle = resolve
    }))
    render(<ToolsScreen />)
    await screen.findByText('Nuclei')
    fireEvent.click(toolCheckbox('Nuclei'))
    fireEvent.click(installButton())

    await waitFor(() => expect(emitOutput).not.toBeNull())
    fireEvent.click(screen.getByText('Nuclei'))
    emitOutput!({ id: 'nuclei', line: 'telechargement...' })

    expect(await screen.findByText('telechargement...')).toBeTruthy()

    settle({ ok: true, installed: true, output: 'telechargement... termine' })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('configure puis retire le jeton GitHub', async () => {
    render(<ToolsScreen />)
    await screen.findByText('Nuclei')
    const input = screen.getByPlaceholderText('Token GitHub…') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  ghp_xxx  ' } })
    fireEvent.click(screen.getByText('Enregistrer'))

    await waitFor(() => expect(ghSet).toHaveBeenCalledWith('ghp_xxx'))
    expect(await screen.findByText('✓ token configuré')).toBeTruthy()

    fireEvent.click(screen.getByText('Retirer'))
    await waitFor(() => expect(ghClear).toHaveBeenCalled())
    expect(screen.queryByText('✓ token configuré')).toBeNull()
  })

  it('affiche l erreur de configuration du jeton', async () => {
    ghSet.mockResolvedValue({ ok: false, error: 'jeton refuse' })
    render(<ToolsScreen />)
    await screen.findByText('Nuclei')
    fireEvent.change(screen.getByPlaceholderText('Token GitHub…'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Enregistrer'))
    expect(await screen.findByText('jeton refuse')).toBeTruthy()
  })

  it('ouvre le guide d un outil', async () => {
    list.mockResolvedValue({ ok: true, tools: [tool({ docs: 'https://docs.example/nuclei' })] })
    render(<ToolsScreen />)
    fireEvent.click(await screen.findByText('Guide'))
    expect(openExternal).toHaveBeenCalledWith('https://docs.example/nuclei')
  })
})
