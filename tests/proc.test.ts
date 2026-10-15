// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'

vi.mock('node:child_process', () => ({
  spawn: vi.fn()
}))

const spawnMock = vi.mocked(spawn)

describe('killTree', () => {
  it('retourne sans faire rien si pid undefined', async () => {
    const { killTree } = await import('../src/main/services/proc')
    const child: any = { pid: undefined }
    killTree(child)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('Windows: taskkill /T /F, fallback sur kill si spawn echoue', async () => {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const { killTree } = await import('../src/main/services/proc')
    const child: any = { pid: 123, kill: vi.fn() }
    spawnMock.mockReturnValueOnce({ on: (evt: string, cb: (err?: any) => void) => { if (evt === 'error') setTimeout(() => cb(new Error('x')), 1); return {} as any } } as any)
    killTree(child)
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '123', '/T', '/F'], expect.objectContaining({ windowsHide: true }))
    await new Promise(r => setTimeout(r, 50))
    Object.defineProperty(process, 'platform', { value: prev })
  })

  it('Unix: tente process.kill -pid SIGTERM; escalade SIGKILL apres 3s', async () => {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const procKill = vi.spyOn(process, 'kill').mockImplementation(() => true as any)
    const { killTree } = await import('../src/main/services/proc')
    const child: any = { pid: 456, kill: vi.fn() }
    killTree(child)
    expect(procKill).toHaveBeenCalledWith(-456, 'SIGTERM')
    await new Promise(r => setTimeout(r, 3200))
    procKill.mockRestore()
    Object.defineProperty(process, 'platform', { value: prev })
  })
})
