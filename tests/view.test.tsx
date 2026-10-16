// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { AgentViewTokenResult, McpStatusInfo } from '../src/shared/ipc'
import { Api } from '../src/renderer/src/api'
import View from '../src/renderer/src/view'

vi.mock('../src/renderer/src/api', () => ({
  Api: { agent: { viewToken: vi.fn(), sessionEnd: vi.fn() }, mcp: { status: vi.fn() } }
}))

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly OPEN = 1
  readyState = 0
  binaryType = ''
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(payload: string): void {
    this.sent.push(payload)
  }
  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  FakeWebSocket.instances.length = 0
})

const viewToken = vi.mocked(Api.agent.viewToken)
const status = vi.mocked(Api.mcp.status)

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('View', () => {
  it('ouvre la socket de vue sur le port du serveur MCP', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    viewToken.mockResolvedValue({ ok: true, token: 'tok' } as AgentViewTokenResult)
    status.mockResolvedValue({ port: 9000 } as McpStatusInfo)

    render(<View />)
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    const ws = FakeWebSocket.instances[0]!
    expect(ws.url).toBe('ws://127.0.0.1:9000/agent/view?token=tok')

    ws.readyState = FakeWebSocket.OPEN
    ws.onopen?.()
    await waitFor(() => expect(screen.getByText('Connecté')).toBeTruthy())
  })

  it("n'ouvre pas de socket si le composant est démonté pendant la résolution", async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const token = deferred<AgentViewTokenResult>()
    const mcpStatus = deferred<McpStatusInfo>()
    viewToken.mockReturnValue(token.promise)
    status.mockReturnValue(mcpStatus.promise)

    const { unmount } = render(<View />)
    unmount()

    token.resolve({ ok: true, token: 'tok' } as AgentViewTokenResult)
    await tick()
    mcpStatus.resolve({ port: 9000 } as McpStatusInfo)
    await tick()

    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})
