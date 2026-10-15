// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

let capturedWillNavigate: ((event: any, url: string) => void) | null = null
let capturedOpenHandler: ((details: any) => { action: string } | void) | null = null

vi.mock('electron', () => {
  const handlers: Array<[string, (...a: any[]) => void]> = []
  return {
    app: {
      isPackaged: true,
      on: vi.fn((event: string, fn: (...a: any[]) => void) => {
        handlers.push([event, fn])
      }),
      getPath: () => '/app/userData'
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: {
          onHeadersReceived: vi.fn()
        }
      }
    },
    shell: { openExternal: vi.fn() }
  }
})

describe('installSecurity (navigation)', () => {
  it('navigations file:// dans le renderer root autorisees', async () => {
    const { app } = await import('electron')
    const { installSecurity } = await import('../src/main/security')
    installSecurity()

    // retrouver will-navigate
    const created = (app.on as any).mock.calls.find((c: any[]) => c[0] === 'web-contents-created')
    const contents = {
      setWindowOpenHandler: vi.fn((fn) => {
        capturedOpenHandler = fn
      }),
      on: vi.fn((event: string, fn: (...a: any[]) => void) => {
        if (event === 'will-navigate') capturedWillNavigate = fn
      })
    }
    created[1]({} as any, contents)

    const root = join(__dirname, '../src/renderer')
    const ev = { preventDefault: vi.fn() }

    capturedWillNavigate?.(ev, 'file://' + root.replace(/\\/g, '/'))
    expect(ev.preventDefault).not.toHaveBeenCalled()

    capturedWillNavigate?.(ev, 'file://' + join(root, 'index.html').replace(/\\/g, '/'))
    expect(ev.preventDefault).not.toHaveBeenCalled()
  })

  it('navigations vers des dossiers externes sont bloquees', async () => {
    const { app } = await import('electron')
    const { installSecurity } = await import('../src/main/security')
    installSecurity()

    const created = (app.on as any).mock.calls.find((c: any[]) => c[0] === 'web-contents-created')
    const contents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, fn: (...a: any[]) => void) => {
        if (event === 'will-navigate') capturedWillNavigate = fn
      })
    }
    created[1]({} as any, contents)

    const ev1 = { preventDefault: vi.fn() }
    capturedWillNavigate?.(ev1, 'file:///c:/Windows/System32')
    expect(ev1.preventDefault).toHaveBeenCalled()

    const ev2 = { preventDefault: vi.fn() }
    capturedWillNavigate?.(ev2, 'file://' + join(__dirname, '../src/main').replace(/\\/g, '/'))
    expect(ev2.preventDefault).toHaveBeenCalled()
  })

  it('https/http sont ouverts dans le shell, autres denies', async () => {
    const { app, shell } = await import('electron')
    const { installSecurity } = await import('../src/main/security')
    installSecurity()

    const created = (app.on as any).mock.calls.find((c: any[]) => c[0] === 'web-contents-created')
    const contents = {
      setWindowOpenHandler: vi.fn((fn) => {
        capturedOpenHandler = fn
      }),
      on: vi.fn()
    }
    created[1]({} as any, contents)

    const res1 = capturedOpenHandler?.({ url: 'https://intigriti.com' })
    expect(res1).toEqual({ action: 'deny' })
    expect(shell.openExternal).toHaveBeenCalled()

    ;(shell.openExternal as any).mockClear()
    const res2 = capturedOpenHandler?.({ url: 'http://localhost:8080' })
    expect(res2).toEqual({ action: 'deny' })
    expect(shell.openExternal).toHaveBeenCalled()

    ;(shell.openExternal as any).mockClear()
    const res3 = capturedOpenHandler?.({ url: 'file:///tmp/x' })
    expect(res3).toEqual({ action: 'deny' })
    expect(shell.openExternal).not.toHaveBeenCalled()

    ;(shell.openExternal as any).mockClear()
    const res4 = capturedOpenHandler?.({ url: 'javascript:alert(1)' })
    expect(res4).toEqual({ action: 'deny' })
    expect(shell.openExternal).not.toHaveBeenCalled()
  })
})
