import { createSocket, type Socket } from 'node:dgram'

export const DISCOVERY_PORT = 47771
export const DISCOVERY_GROUP = '239.255.77.77'
/** Marqueur du protocole : une application tierce qui sonde le meme port sans le connaitre ne recoit rien. */
export const DISCOVERY_PROBE = 'venari-discover'

let socket: Socket | null = null

/**
 * Repond aux sondes de decouverte UDP avec l'etat courant du serveur MCP.
 * Tant que le serveur tourne, `npm run mcp:pair` sur le meme poste ou sur le
 * LAN trouve l'installation sans saisir d'adresse ni de port.
 *
 * Aucun secret ne circule : la reponse ne contient que le pairId (identifiant
 * public du processus), l'hote, le port et le fait qu'un appairage est possible.
 */
export function startDiscoveryResponder(
  payload: () => Record<string, unknown>,
  port = DISCOVERY_PORT
): Promise<number> {
  stopDiscoveryResponder()
  return new Promise<number>((resolve) => {
    let settled = false
    // Resout le port reellement lie : les tests demandent un port ephemere (0)
    // pour ne pas se disputer le port fixe de decouverte, puis sondent celui-ci.
    const settle = (boundPort: number): void => {
      if (settled) return
      settled = true
      resolve(boundPort)
    }
    const sock = createSocket({ type: 'udp4', reuseAddr: true })
    socket = sock
    // Une erreur (port pris, multicast indisponible) desactive la reponse : la
    // decouverte est un confort, jamais une condition de fonctionnement du MCP.
    sock.on('error', () => {
      stopDiscoveryResponder()
      settle(port)
    })
    sock.on('message', (msg: Buffer, rinfo: { address: string; port: number }) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(msg.toString('utf8'))
      } catch {
        return
      }
      if ((parsed as { probe?: unknown } | null)?.probe !== DISCOVERY_PROBE) return
      const reply = Buffer.from(JSON.stringify(payload()))
      sock.send(reply, rinfo.port, rinfo.address, () => {})
    })
    sock.bind(port, () => {
      try {
        sock.addMembership(DISCOVERY_GROUP)
      } catch {
        // Interface sans multicast : la sonde loopback fonctionne toujours.
      }
      const addr = sock.address()
      settle(typeof addr === 'object' && addr !== null ? addr.port : port)
    })
  })
}

export function stopDiscoveryResponder(): void {
  const s = socket
  socket = null
  if (!s) return
  try {
    s.close()
  } catch {
    // Deja ferme.
  }
}
