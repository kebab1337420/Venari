import { useEffect, useRef, useState } from 'react'
import { Api } from './api'
import './styles.css'

export default function View(): React.JSX.Element {
  const imgRef = useRef<HTMLImageElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const tokenRef = useRef('')
  const lastFrameUrl = useRef<string | null>(null)
  // File d'attente souris : un survol envoie des dizaines d'événements par
  // seconde, on n'émet que la dernière position à 25 Hz (les clics, eux,
  // partent tout de suite pour rester exacts).
  const pendingMouse = useRef<Record<string, unknown> | null>(null)
  const mouseFlush = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [connected, setConnected] = useState(false)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [message, setMessage] = useState('Connexion…')
  const [fps, setFps] = useState(12)
  const [quality, setQuality] = useState(75)

  useEffect(() => {
    let closed = false
    void (async () => {
      const res = await Api.agent.viewToken()
      if (closed) return
      if (!res.ok) {
        setMessage('Fenêtre de vue invalide (jeton refusé).')
        return
      }
      const token = res.token
      tokenRef.current = token
      const status = await Api.mcp.status()
      // Le cleanup ne ferme que wsRef.current : si le composant a été démonté
      // pendant les attentes, ouvrir la socket ici la laisserait en vie (avec un
      // viewer rattaché côté serveur).
      if (closed) return
      const port = status.port ?? 8787
      const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/view?token=${encodeURIComponent(token)}`)
      wsRef.current = ws
      ws.binaryType = 'blob'

      ws.onopen = () => {
        if (closed) return
        setConnected(true)
        setMessage('Connecté')
      }
      ws.onmessage = (ev) => {
        if (closed) return
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data) as { type?: string; width?: number; height?: number }
            if (msg.type === 'start' && msg.width && msg.height) {
              setSize({ width: msg.width, height: msg.height })
              setMessage('Session active')
            }
          } catch {
            // ignore
          }
        } else {
          const url = URL.createObjectURL(ev.data as Blob)
          // L'image précédente est révoquée dès la suivante : aucun objet
          // blob ne reste en mémoire, même si onload n'a jamais été atteint.
          if (lastFrameUrl.current) URL.revokeObjectURL(lastFrameUrl.current)
          lastFrameUrl.current = url
          if (imgRef.current) imgRef.current.src = url
        }
      }
      ws.onclose = () => {
        setConnected(false)
        setMessage('Session terminée')
      }
      ws.onerror = () => {
        setMessage('Erreur de connexion à la vue')
      }
    })()

    return () => {
      closed = true
      if (mouseFlush.current) clearTimeout(mouseFlush.current)
      wsRef.current?.close()
      wsRef.current = null
      if (lastFrameUrl.current) {
        URL.revokeObjectURL(lastFrameUrl.current)
        lastFrameUrl.current = null
      }
    }
  }, [])

  const sendEvents = (events: Record<string, unknown>[]): void => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'input', events }))
  }

  const sendInput = (type: string, extra: Record<string, unknown>): void => {
    sendEvents([{ type, ...extra }])
  }

  const buildMouse = (e: React.MouseEvent<HTMLImageElement>): Record<string, unknown> => {
    const rect = e.currentTarget.getBoundingClientRect()
    const payload: Record<string, unknown> = { type: e.type }
    if (e.type !== 'mousemove') {
      payload.action = e.type === 'mousedown' ? 'down' : 'up'
      payload.button = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle'
    }
    payload.x = (e.clientX - rect.left) / rect.width
    payload.y = (e.clientY - rect.top) / rect.height
    payload.kind = 'relative'
    return payload
  }

  const handleMouse = (e: React.MouseEvent<HTMLImageElement>): void => {
    const payload = buildMouse(e)
    if (e.type !== 'mousemove') {
      // Un clic n'attend pas : la position en attente est vidée d'abord pour
      // préserver l'ordre chronologique des événements.
      if (mouseFlush.current) {
        clearTimeout(mouseFlush.current)
        mouseFlush.current = null
      }
      const pending = pendingMouse.current
      pendingMouse.current = null
      if (pending) sendEvents([pending])
      sendEvents([payload])
      return
    }
    pendingMouse.current = payload
    if (!mouseFlush.current) {
      mouseFlush.current = setTimeout(() => {
        mouseFlush.current = null
        const p = pendingMouse.current
        if (p) {
          pendingMouse.current = null
          sendEvents([p])
        }
      }, 40)
    }
  }

  const handleWheel = (e: React.WheelEvent<HTMLImageElement>): void => {
    sendInput('wheel', { deltaY: e.deltaY })
  }

  const sendConfig = (maxFps: number, q: number): void => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'streamConfig', maxFps, quality: q }))
  }

  const sendCombo = (key: string, code: string, flags: Record<string, boolean>): void => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(
      JSON.stringify({
        type: 'input',
        events: [
          { type: 'keydown', key, code, ...flags },
          { type: 'keyup', key, code, ...flags },
        ],
      }),
    )
  }

  const handleKey = (e: React.KeyboardEvent<HTMLImageElement>): void => {
    const action = e.type === 'keydown' ? 'down' : 'up'
    sendInput(action === 'down' ? 'keydown' : 'keyup', { key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey })
    e.preventDefault()
  }

  const disconnect = (): void => {
    const ws = wsRef.current
    const token = tokenRef.current
    ws?.close()
    wsRef.current = null
    if (token) {
      void Api.agent.sessionEnd(token)
    }
    window.close()
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: '#151a21', borderBottom: '1px solid #262d39' }}>
        <span style={{ width: 10, height: 10, borderRadius: 99, background: connected ? '#34d399' : '#ef4444' }} />
        <span className="muted-text" style={{ flex: 1 }}>
          {message}
        </span>
        {size && (
          <span className="muted-text">
            {size.width}×{size.height}
          </span>
        )}
        <button className="btn danger small" onClick={disconnect}>
          Déconnecter
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', background: '#11161d', borderBottom: '1px solid #262d39', flexWrap: 'wrap' }}>
        <label className="muted-text" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          FPS
          <input
            type="range"
            min={3}
            max={12}
            step={1}
            value={fps}
            onChange={(e) => {
              const v = Number(e.target.value)
              setFps(v)
              sendConfig(v, quality)
            }}
            style={{ width: 90 }}
          />
          <span style={{ color: '#d7dce5', width: 22 }}>{fps}</span>
        </label>
        <label className="muted-text" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Qualité
          <input
            type="range"
            min={20}
            max={95}
            step={1}
            value={quality}
            onChange={(e) => {
              const v = Number(e.target.value)
              setQuality(v)
              sendConfig(fps, v)
            }}
            style={{ width: 90 }}
          />
          <span style={{ color: '#d7dce5', width: 30 }}>{quality}</span>
        </label>
        <span style={{ flex: 1 }} />
        <button
          className="btn ghost small"
          onClick={() => sendCombo('Delete', 'Delete', { ctrl: true, alt: true })}
          title="Ctrl+Alt+Suppr"
        >
          Ctrl+Alt+Suppr
        </button>
        <button
          className="btn ghost small"
          onClick={() => sendCombo('Escape', 'Escape', { ctrl: true, shift: true })}
          title="Ctrl+Maj+Échap"
        >
          Ctrl+Maj+Échap
        </button>
        <button
          className="btn ghost small"
          onClick={() => sendCombo('l', 'KeyL', { meta: true })}
          title="Win+L"
        >
          Win+L
        </button>
      </div>
      <div style={{ flex: 1, position: 'relative', background: '#0e1116', overflow: 'hidden' }}>
        <img
          ref={imgRef}
          alt="Écran distant"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'auto' }}
          onMouseMove={handleMouse}
          onMouseDown={handleMouse}
          onMouseUp={handleMouse}
          onWheel={handleWheel}
          onKeyDown={handleKey}
          onKeyUp={handleKey}
          tabIndex={0}
        />
      </div>
    </div>
  )
}