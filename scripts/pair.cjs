#!/usr/bin/env node
'use strict'

/**
 * Client d'appairage Venari, sans dependance.
 *
 * Il decouvre le serveur MCP sur le reseau local (sonde UDP multicast, repli
 * loopback), demande le code affiche dans Reglages -> Assistant IA, l'echange
 * contre un jeton dedie, puis imprime la configuration MCP prete a coller.
 *
 *   node scripts/pair.cjs                 # decouvre, puis demande le code
 *   node scripts/pair.cjs ABC123          # code fourni en argument
 *   node scripts/pair.cjs --host 10.0.0.5 --port 8787
 */

const dgram = require('node:dgram')
const readline = require('node:readline/promises')

const DISCOVERY_PORT = 47771
const DISCOVERY_GROUP = '239.255.77.77'
const DISCOVERY_PROBE = 'venari-discover'
const DISCOVERY_TIMEOUT_MS = 1500

function parseArgs(argv) {
  const out = { code: '', host: '', port: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--host') out.host = argv[++i] ?? ''
    else if (a === '--port') out.port = Number(argv[++i])
    else if (!a.startsWith('-') && !out.code) out.code = a
  }
  return out
}

/** Sonde le LAN en multicast puis en loopback. Resout le premier serveur qui repond. */
function discover() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        // deja ferme
      }
      resolve(value)
    }
    const probe = Buffer.from(JSON.stringify({ probe: DISCOVERY_PROBE }))
    sock.on('message', (msg) => {
      try {
        finish(JSON.parse(msg.toString('utf8')))
      } catch {
        // reponse illisible : on ignore et on attend la suivante
      }
    })
    sock.on('error', () => finish(null))
    sock.bind(() => {
      try {
        sock.setBroadcast(true)
        sock.addMembership(DISCOVERY_GROUP)
      } catch {
        // pas de multicast : le repli loopback ci-dessous suffit sur le meme poste
      }
      sock.send(probe, DISCOVERY_PORT, '127.0.0.1', () => {})
      try {
        sock.send(probe, DISCOVERY_PORT, DISCOVERY_GROUP, () => {})
      } catch {
        // envoi multicast impossible : on a deja tente le loopback
      }
    })
    const timer = setTimeout(() => finish(null), DISCOVERY_TIMEOUT_MS)
  })
}

async function askCode() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question('Code d’appairage (Reglages -> Assistant IA) : ')).trim()
  } finally {
    rl.close()
  }
}

function printConfig(token, host, port) {
  const cfg = {
    bountydesk: {
      type: 'remote',
      url: `http://${host}:${port}/mcp`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    },
  }
  console.log('\nAppairé. Configuration MCP (clé « bountydesk ») :\n')
  console.log(JSON.stringify(cfg, null, 2))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let found = null
  if (!args.host || !args.port) {
    found = await discover()
    if (!found) {
      console.error('Aucun serveur Venari découvert. Activez le serveur MCP et le mode LAN, ou passez --host/--port.')
      process.exitCode = 1
      return
    }
    console.log(`Serveur trouvé : pairId ${found.pairId ?? '?'} · port ${found.port ?? '?'}`)
  }
  const host = args.host || found.hosts?.[0] || '127.0.0.1'
  const port = args.port || found.port
  if (!port) {
    console.error('Port introuvable : passez --port.')
    process.exitCode = 1
    return
  }

  const code = args.code || (await askCode())
  if (!code) {
    console.error('Code manquant.')
    process.exitCode = 1
    return
  }

  let res
  try {
    res = await fetch(`http://${host}:${port}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    console.error(`Échec de connexion à ${host}:${port} : ${err.message}`)
    process.exitCode = 1
    return
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.ok) {
    console.error(`Appairage refusé : ${body.error ?? `HTTP ${res.status}`}`)
    process.exitCode = 1
    return
  }
  printConfig(body.token, host, body.port ?? port)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
