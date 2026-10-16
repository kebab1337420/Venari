import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(join(tmpdir(), 'bountydesk-app-')) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { handle: vi.fn() },
}))

import {
  assertStaysInside,
  findFile,
  pathExecutableNames,
  selectWindowsAsset,
  unsafeArchiveEntry,
  withSystemInstallLock,
} from '../src/main/services/tools/installer'

describe('findFile (extraction d’archives GitHub)', () => {
  it('trouve un binaire à la racine par basename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bountydesk-findfile-'))
    const zip = join(dir, 'nuclei.zip')
    const nope = join(dir, 'nope')
    mkdirSync(nope)
    writeFileSync(join(nope, 'x.exe'), 'x')
    writeFileSync(zip, 'zip')
    const found = findFile(dir, (name) => name.toLowerCase() === 'nuclei.zip')
    expect(found).toBe(zip)
    rmSync(dir, { recursive: true, force: true })
  })

  it('trouve un exe imbriqué dans un sous-dossier (ex: amass_windows_amd64/amass.exe)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bountydesk-findfile-'))
    const inner = join(dir, 'amass_windows_amd64')
    mkdirSync(inner)
    writeFileSync(join(dir, 'README.md'), 'r')
    writeFileSync(join(inner, 'amass.exe'), 'bin')
    const found = findFile(dir, (name) => name.toLowerCase() === 'amass.exe')
    expect(found).toBe(join(inner, 'amass.exe'))
    rmSync(dir, { recursive: true, force: true })
  })

  it('retourne null quand aucun fichier ne correspond', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bountydesk-findfile-'))
    writeFileSync(join(dir, 'LICENSE'), 'l')
    const found = findFile(dir, (name) => name.toLowerCase() === 'nuclei.exe')
    expect(found).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('selectWindowsAsset (sélection d’asset Windows)', () => {
  const assets = (names: string[]) => names.map((name) => ({ name, browser_download_url: `https://x/${name}` }))

  it('match unique direct (interactsh-client)', () => {
    const url = selectWindowsAsset('projectdiscovery/interactsh', 'client', assets([
      'interactsh-server_1.4.0_windows_386.zip',
      'interactsh-client_1.4.0_windows_386.zip',
      'interactsh-client_1.4.0_windows_amd64.zip',
      'interactsh-server_1.4.0_windows_amd64.zip'
    ]))
    expect(url).toBe('https://x/interactsh-client_1.4.0_windows_amd64.zip')
  })

  it('préfère amd64 quand 386 et amd64 matchent', () => {
    const url = selectWindowsAsset('projectdiscovery/tlsx', 'windows_amd64', assets([
      'tlsx_1.4.0_windows_386.zip',
      'tlsx_1.4.0_windows_amd64.zip'
    ]))
    expect(url).toBe('https://x/tlsx_1.4.0_windows_amd64.zip')
  })

  it('jette une erreur sur plusieurs candidats amd64 (client + serveur)', () => {
    expect(() => selectWindowsAsset('projectdiscovery/interactsh', 'windows_amd64', assets([
      'interactsh-client_1.4.0_windows_amd64.zip',
      'interactsh-server_1.4.0_windows_amd64.zip'
    ]))).toThrow(/ambigu/)
  })

  it('jette une erreur quand aucun asset ne matche', () => {
    expect(() => selectWindowsAsset('x/y', 'windows', assets(['tool_1.0_linux_amd64.zip']))).toThrow(/Aucun asset/)
  })

  it('écarte le 32 bits quand le nom ne dit pas amd64 (findomain)', () => {
    const url = selectWindowsAsset('findomain/findomain', 'findomain-windows', assets([
      'findomain-windows-i686.exe.zip',
      'findomain-windows.exe.zip'
    ]))
    expect(url).toBe('https://x/findomain-windows.exe.zip')
  })

  it('restreint aux assets windows même si le filtre matche plusieurs plateformes', () => {
    // liste réelle de la release interactsh v1.4.0 : le filtre "client" matche
    // aussi les builds linux et darwin, seuls les windows doivent être retenus
    // (piège : "darwin" contient la sous-chaîne "win")
    const url = selectWindowsAsset('projectdiscovery/interactsh', 'client', assets([
      'interactsh-client_1.4.0_darwin_amd64.zip',
      'interactsh-client_1.4.0_darwin_arm64.zip',
      'interactsh-client_1.4.0_linux_386.zip',
      'interactsh-client_1.4.0_linux_amd64.zip',
      'interactsh-client_1.4.0_linux_arm64.zip',
      'interactsh-client_1.4.0_windows_386.zip',
      'interactsh-client_1.4.0_windows_amd64.zip',
      'interactsh-client_1.4.0_windows_arm64.zip'
    ]))
    expect(url).toBe('https://x/interactsh-client_1.4.0_windows_amd64.zip')
  })

  it('ignore les fichiers de checksum (seules les archives zip/tgz sont retenues)', () => {
    const url = selectWindowsAsset('x/y', 'windows_amd64', assets([
      'tool_1.0_windows_amd64.zip',
      'tool_1.0_windows_amd64.zip.sha256',
      'tool_1.0_checksums_windows_amd64.txt'
    ]))
    expect(url).toBe('https://x/tool_1.0_windows_amd64.zip')
  })
})

describe('assertStaysInside (archive qui sortirait du dossier)', () => {
  // tar ustar construit à la main : aucun binaire de fixture à versionner.
  function buildTar(names: string[]): Buffer {
    const blocks: Buffer[] = []
    for (const name of names) {
      const header = Buffer.alloc(512, 0)
      header.write(name, 0, 100, 'utf8')
      header.write('0000644\0', 100, 'ascii')
      header.write('0000000\0', 108, 'ascii')
      header.write('0000000\0', 116, 'ascii')
      header.write('00000000000\0', 124, 'ascii')
      header.write('00000000000\0', 136, 'ascii')
      header.write('        ', 148, 'ascii')
      header.write('0', 156, 'ascii')
      header.write('ustar\0', 257, 'ascii')
      header.write('00', 263, 'ascii')
      let sum = 0
      for (const byte of header) sum += byte
      header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
      blocks.push(header)
    }
    blocks.push(Buffer.alloc(1024, 0))
    return Buffer.concat(blocks)
  }

  function writeTar(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'bountydesk-tar-'))
    const file = join(dir, 'archive.tar')
    writeFileSync(file, buildTar(names))
    return file
  }

  it('laisse passer une archive ordinaire', async () => {
    await expect(assertStaysInside(writeTar(['tool.exe', 'README.md']))).resolves.toBeUndefined()
  })

  it('refuse une entrée ../', async () => {
    await expect(assertStaysInside(writeTar(['../escaped.txt']))).rejects.toThrow(/hors dossier/)
  })

  it('refuse un ../ noyé dans un chemin', async () => {
    await expect(assertStaysInside(writeTar(['bin/../../escaped.txt']))).rejects.toThrow(/hors dossier/)
  })
})

describe('unsafeArchiveEntry (validation pure d’une entrée)', () => {
  it('laisse passer un chemin relatif ordinaire', () => {
    expect(unsafeArchiveEntry('tool.exe')).toBeNull()
    expect(unsafeArchiveEntry('bin/tool.exe')).toBeNull()
  })

  it('refuse les chemins absolus Unix, UNC et Windows', () => {
    expect(unsafeArchiveEntry('/etc/passwd')).toMatch(/absolu/)
    expect(unsafeArchiveEntry('//srv/share/evil')).toMatch(/absolu/)
    expect(unsafeArchiveEntry('C:\\Windows\\evil.dll')).toMatch(/absolu/)
    expect(unsafeArchiveEntry('C:/Windows/evil.dll')).toMatch(/absolu/)
  })

  it('refuse toute remontée de répertoire', () => {
    expect(unsafeArchiveEntry('../escaped.txt')).toMatch(/hors dossier/)
    expect(unsafeArchiveEntry('bin/../escaped.txt')).toMatch(/hors dossier/)
    expect(unsafeArchiveEntry('bin\\..\\escaped.txt')).toMatch(/hors dossier/)
  })
})

describe('index PATH (détection sans spawn de processus)', () => {
  const isWin = process.platform === 'win32'

  // Le scan lit chaque dossier du PATH : sur la machine hote il peut inclure
  // des repertoires volumineux ou un chemin reseau lent, ce qui faisait
  // depasser le delai sous charge en CI. En isolant le PATH dans un dossier
  // temporaire, le resultat ne depend plus que du contenu teste.
  function fakePathDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bountydesk-path-'))
    writeFileSync(join(dir, isWin ? 'bdfake-tool.exe' : 'bdfake-tool'), '')
    return dir
  }

  it('trouve un exécutable déposé dans un dossier du PATH', () => {
    const dir = fakePathDir()
    const saved = process.env.PATH
    process.env.PATH = dir
    try {
      expect(pathExecutableNames().has('bdfake-tool')).toBe(true)
      expect(pathExecutableNames().has('bdfake-absent-9f3')).toBe(false)
    } finally {
      process.env.PATH = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('se re-indexe quand le PATH change', () => {
    const dir = fakePathDir()
    const saved = process.env.PATH
    try {
      process.env.PATH = ''
      expect(pathExecutableNames().size).toBe(0)
      process.env.PATH = dir
      expect(pathExecutableNames().size).toBe(1)
    } finally {
      process.env.PATH = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('verrou installation système', () => {
  const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  it('ne passe jamais deux installations système en même temps', async () => {
    let inside = 0
    let peak = 0
    const critical = async (): Promise<void> => {
      inside++
      peak = Math.max(peak, inside)
      await tick(15)
      inside--
    }
    await Promise.all([
      withSystemInstallLock(critical),
      withSystemInstallLock(critical),
      withSystemInstallLock(critical)
    ])
    expect(peak).toBe(1)
  })

  it('reprend après un échec au lieu de bloquer la file', async () => {
    await expect(withSystemInstallLock(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(withSystemInstallLock(() => Promise.resolve('ok'))).resolves.toBe('ok')
  })
})
