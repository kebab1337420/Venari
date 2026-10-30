import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const userData = mkdtempSync(join(tmpdir(), 'bountydesk-inst-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { handle: vi.fn() },
}))

import { isChecksumAsset, parseChecksums, safeEqualHex, sha256File } from '../src/main/services/tools/integrity'
import { purgeInstallResidues, toolsDir } from '../src/main/services/tools/installer'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)

describe('integrity — detection des fichiers de sommes', () => {
  it('reconnait les noms de checksums usuels, insensibles a la casse', () => {
    expect(isChecksumAsset('checksums.txt')).toBe(true)
    expect(isChecksumAsset('SHA256SUMS')).toBe(true)
    expect(isChecksumAsset('checksums.sha256')).toBe(true)
    expect(isChecksumAsset('nuclei_3.2.1_linux_amd64.zip')).toBe(false)
  })
})

describe('integrity — parsing des checksums', () => {
  it('lit les formats sha256sum, shasum et maison', () => {
    const map = parseChecksums(
      [
        '# commentaire',
        '',
        `${HEX_A}  subfinder_2.6.7_linux_amd64.zip`,
        `${HEX_B} *ffuf_2.1.0_windows_amd64.zip`,
        `SHA256 (katana_linux_amd64.zip) = ${HEX_A}`
      ].join('\n')
    )
    expect(map.get('subfinder_2.6.7_linux_amd64.zip')).toBe(HEX_A)
    expect(map.get('ffuf_2.1.0_windows_amd64.zip')).toBe(HEX_B)
    expect(map.get('katana_linux_amd64.zip')).toBe(HEX_A)
  })

  it('ignore les lignes qui ne sont pas des sommes', () => {
    const map = parseChecksums('readme\npas une somme\ndeadbeef  court.zip\n')
    expect(map.size).toBe(0)
  })

  it('ne depend pas du chemin complet dans le fichier de checksums', () => {
    const map = parseChecksums(`${HEX_A}  dist/intermediaire/nuclei_3.2.1_linux_amd64.zip`)
    expect(map.get('nuclei_3.2.1_linux_amd64.zip')).toBe(HEX_A)
  })
})

describe('integrity — comparaison de sommes', () => {
  it('accepte l\'identique et refuse le different ou le different de longueur', () => {
    expect(safeEqualHex(HEX_A, HEX_A)).toBe(true)
    expect(safeEqualHex(HEX_A, HEX_B)).toBe(false)
    expect(safeEqualHex(HEX_A, HEX_A.slice(0, 32))).toBe(false)
  })

  it('rejette les entrees vides, de longueur impaire, non-hex ou de casse incoherente', () => {
    expect(safeEqualHex('', '')).toBe(false)
    expect(safeEqualHex('abc', 'abc')).toBe(false) // longueur impaire -> pas un hex valide
    expect(safeEqualHex(HEX_A, HEX_A.replace(/a/g, 'g'))).toBe(false) // caractere non-hex
    expect(safeEqualHex(HEX_A.toUpperCase(), HEX_A.toUpperCase())).toBe(true) // casse insensible
    expect(safeEqualHex(HEX_A.toUpperCase(), HEX_B.toUpperCase())).toBe(false)
  })
})

describe('integrity — SHA-256 d\'un fichier', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bountydesk-sha-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('calcule la meme empreinte que crypto, y compris sur un gros fichier', async () => {
    const payload = Buffer.alloc(3 * 1024 * 1024, 7)
    const file = join(dir, 'blob.bin')
    writeFileSync(file, payload)
    expect(await sha256File(file)).toBe(createHash('sha256').update(payload).digest('hex'))
  })

  it('refuse un fichier absent', async () => {
    await expect(sha256File(join(dir, 'absent.bin'))).rejects.toThrow()
  })
})

describe('purge des residus d\'installation', () => {
  let tools = ''
  beforeEach(() => {
    tools = toolsDir()
    rmSync(tools, { recursive: true, force: true })
    mkdirSync(tools, { recursive: true })
  })
  afterEach(() => {
    rmSync(tools, { recursive: true, force: true })
  })

  it('supprime archives et dossiers temporaires, garde les outils installs', () => {
    writeFileSync(join(tools, 'nuclei.download.tar.gz'), 'archive')
    writeFileSync(join(tools, 'ffuf.download.zip'), 'archive')
    mkdirSync(join(tools, 'httpx.tmp'))
    writeFileSync(join(tools, 'httpx.tmp', 'partiel'), 'x')
    mkdirSync(join(tools, 'nuclei'))
    writeFileSync(join(tools, 'nuclei', 'nuclei'), 'binaire')

    expect(purgeInstallResidues()).toBe(3)
    expect(existsSync(join(tools, 'nuclei.download.tar.gz'))).toBe(false)
    expect(existsSync(join(tools, 'ffuf.download.zip'))).toBe(false)
    expect(existsSync(join(tools, 'httpx.tmp'))).toBe(false)
    expect(readFileSync(join(tools, 'nuclei', 'nuclei'), 'utf8')).toBe('binaire')
  })

  it('ne touche pas aux fichiers qui ne sont pas des residus', () => {
    writeFileSync(join(tools, 'nuclei'), 'binaire')
    writeFileSync(join(tools, 'notes.txt'), 'x')
    expect(purgeInstallResidues()).toBe(0)
    expect(existsSync(join(tools, 'nuclei'))).toBe(true)
    expect(existsSync(join(tools, 'notes.txt'))).toBe(true)
  })

  it('renvoie 0 si le dossier des outils n\'existe pas encore', () => {
    rmSync(tools, { recursive: true, force: true })
    expect(purgeInstallResidues()).toBe(0)
  })
})
