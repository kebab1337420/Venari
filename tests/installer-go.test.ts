import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// userData unique : toolsDir() doit retourner le même dossier à chaque appel.
const root = vi.hoisted(() => ({
  dir: `${process.env.TEMP ?? '/tmp'}/bountydesk-go-test-${process.pid}`
}))

vi.mock('electron', () => ({
  app: { getPath: () => root.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { handle: vi.fn() },
}))

// Fake de node:child_process contrôlé par test : simulate les appels à `go`
// sans réseau ni toolchain réelle.
const fake = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'missing' | 'fail' | 'no-binary',
  spawns: [] as { cmd: string; args: string[]; gobin?: string }[],
  // Bloque la détection `go version` jusqu'à relâchement explicite.
  hang: false,
  held: null as null | (() => void)
}))

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
    fake.spawns.push({ cmd, args, gobin: opts?.env?.GOBIN })
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    queueMicrotask(() => {
      if (fake.hang && args[0] === 'version') {
        fake.held = () => child.emit('close', 0)
        return
      }
      if (fake.mode === 'missing') {
        child.emit('error', Object.assign(new Error('spawn go ENOENT'), { code: 'ENOENT' }))
        return
      }
      if (args[0] === 'version') {
        child.emit('close', 0)
        return
      }
      if (args[0] === 'install') {
        if (fake.mode === 'fail') {
          child.emit('close', 1)
          return
        }
        if (fake.mode === 'ok' && opts?.env?.GOBIN) {
          const exe = process.platform === 'win32' ? 'fff.exe' : 'fff'
          mkdirSync(opts.env.GOBIN, { recursive: true })
          writeFileSync(join(opts.env.GOBIN, exe), 'fake go binary')
        }
        child.emit('close', 0)
        return
      }
      child.emit('close', 0)
    })
    return child
  }
}))

import { installTool, isInstalled, toolsDir } from '../src/main/services/tools/installer'
import { getTool } from '../src/main/services/tools/catalog'

const exeName = (): string => (process.platform === 'win32' ? 'fff.exe' : 'fff')

describe('source go (go install en GOBIN isolé)', () => {
  it('le catalogue déclare les outils Go avec un module', () => {
    for (const id of ['fff', 'hakrawler', 'haktrails', 'gospider', 'gauplus']) {
      const tool = getTool(id)
      expect(tool?.source).toBe('go')
      expect(tool?.goPackage).toMatch(/^github\.com\//)
    }
  })

  it('installe via go install avec GOBIN = tools/<id> et détecte le binaire', async () => {
    fake.mode = 'ok'
    fake.spawns.length = 0
    const lines: string[] = []
    const result = await installTool('fff', (line) => lines.push(line))
    const install = fake.spawns.find((s) => s.args[0] === 'install')

    expect(result).toEqual({ ok: true, installed: true })
    // Le binaire `go` est résolu en chemin absolu (anti-détournement PATH) :
    // on accepte le nom nu comme un chemin qui se termine par go(.exe).
    expect(install?.cmd).toMatch(/^(?:.*[\\/])?go(?:\.exe)?$/i)
    expect(install?.args).toEqual(['install', 'github.com/tomnomnom/fff'])
    expect(install?.gobin).toBe(join(toolsDir(), 'fff'))
    expect(lines.join('\n')).toMatch(/go install github\.com\/tomnomnom\/fff/)
    expect(await isInstalled(getTool('fff')!)).toBe(true)
    rmSync(join(toolsDir(), 'fff'), { recursive: true, force: true })
  })

  it('go absent : refus actionnable, aucun téléchargement', async () => {
    fake.mode = 'missing'
    fake.spawns.length = 0
    const result = await installTool('fff')
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/Go introuvable/) })
    expect(fake.spawns.filter((s) => s.args[0] === 'install')).toHaveLength(0)
  })

  it('go install échoue (code retour non nul)', async () => {
    fake.mode = 'fail'
    const result = await installTool('fff')
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/go install a échoué \(code 1\)/) })
  })

  it('go install réussit mais ne produit pas le binaire attendu', async () => {
    fake.mode = 'no-binary'
    const result = await installTool('fff')
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/introuvable après go install[\s\S]*exeName/)
    })
  })

  it('isInstalled : faux sans binaire, vrai avec le binaire à sa place', async () => {
    fake.mode = 'missing'
    const tool = getTool('fff')!
    expect(await isInstalled(tool)).toBe(false)
    const binDir = join(toolsDir(), 'fff')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, exeName()), 'x')
    expect(await isInstalled(tool)).toBe(true)
    rmSync(binDir, { recursive: true, force: true })
  })

  it('refuse une deuxième installation du même outil pendant qu’une est en cours', async () => {
    fake.hang = true
    fake.spawns.length = 0
    const first = installTool('fff')
    await new Promise((r) => setTimeout(r, 0))
    const second = await installTool('fff')
    expect(second.ok).toBe(false)
    expect(second).toEqual({ ok: false, error: expect.stringMatching(/déjà en cours/) })

    // On relâche la détection : la première installation doit pouvoir finir.
    fake.hang = false
    fake.mode = 'ok'
    fake.held?.()
    const res = await first
    expect(res).toEqual({ ok: true, installed: true })
    rmSync(join(toolsDir(), 'fff'), { recursive: true, force: true })
  })
})
