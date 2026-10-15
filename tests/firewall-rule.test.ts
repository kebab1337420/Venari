import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => require('node:os').tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { handle: vi.fn() },
  clipboard: { writeText: vi.fn() },
  Notification: class {},
}))

import { netshRuleFound } from '../src/main/ipc-mcp'

describe('netshRuleFound', () => {
  it('reconnait la regle Venari MCP dans la sortie netsh francaise', () => {
    const stdout = [
      'Nom de la regle :                 Venari MCP',
      'Compatibilite :                    Windows Vista et au-dessus',
      'Direction :                        Entree',
      'Actif :                            Oui',
      'Profiles :                         Prive',
    ].join('\r\n')
    expect(netshRuleFound({ code: 0, stdout })).toBe(true)
  })

  it('reconnait la regle dans la sortie netsh anglaise', () => {
    expect(netshRuleFound({ code: 0, stdout: 'Rule Name:                 Venari MCP' })).toBe(true)
  })

  it('ne confond pas un ancien nom avec la regle actuelle', () => {
    // Sortie d'une regle « BountyDesk MCP » survive : ne doit pas servir de
    // preuve pour « Venari MCP ».
    expect(netshRuleFound({ code: 0, stdout: 'Rule Name:                 BountyDesk MCP' })).toBe(false)
  })

  it('refuse quand aucune regle ne correspond', () => {
    expect(netshRuleFound({ code: 0, stdout: 'No rules match the specified criteria.' })).toBe(false)
    expect(netshRuleFound({ code: 1, stdout: '' })).toBe(false)
  })
})
