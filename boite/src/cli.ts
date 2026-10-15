#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { BoiteError } from './errors.ts'
import { openDb } from './db.ts'
import {
  archiveAgent,
  createAgent,
  doneAgent,
  editAgent,
  findAgents,
  listAgents,
  logThread,
  pauseAgent,
  readThread,
  replyMessage,
  restoreAgent,
  resumeAgent,
  runAgent,
  sendMessage,
  waitForReply,
  waitForState,
  type AgentRow,
  type MessageRow
} from './store.ts'
import { isWorking } from './gate.ts'

interface Flags {
  all: boolean
  json: boolean
  wait: boolean
  ready: boolean
  follow: boolean
  waiting: boolean
  help: boolean
  refs: string[]
  projects: string[]
  id: string | null
  limit: number
  timeout: number | null
}

const BOOLEAN_FLAGS = new Set(['all', 'json', 'wait', 'ready', 'follow', 'waiting', 'help'])
const VALUE_FLAGS: Record<string, keyof Flags> = {
  ref: 'refs',
  project: 'projects',
  id: 'id',
  limit: 'limit',
  timeout: 'timeout'
}

interface ParsedArgs {
  flags: Flags
  positionals: string[]
}

function usageError(message: string): BoiteError {
  return new BoiteError('USAGE', message)
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Flags = {
    all: false,
    json: false,
    wait: false,
    ready: false,
    follow: false,
    waiting: false,
    help: false,
    refs: [],
    projects: [],
    id: null,
    limit: 20,
    timeout: null
  }
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token === '-h') {
      flags.help = true
      continue
    }
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const name = token.slice(2)
    if (BOOLEAN_FLAGS.has(name)) {
      ;(flags as unknown as Record<string, boolean>)[name] = true
      continue
    }
    const key = VALUE_FLAGS[name]
    if (!key) throw usageError(`option inconnue '--${name}'`)
    const value = argv[++i]
    if (value === undefined) throw usageError(`option '--${name}' sans valeur`)
    if (key === 'refs') flags.refs.push(value)
    else if (key === 'projects') flags.projects.push(value)
    else if (key === 'id') flags.id = value
    else if (key === 'limit' || key === 'timeout') {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) throw usageError(`valeur invalide pour '--${name}' : ${value}`)
      if (key === 'limit') flags.limit = Math.floor(n)
      // Au minimum 1 ms : un `--timeout 0.0005` plafonné à 0 serait traité
      // comme « pas de délai » et figerait l'attente pour toujours.
      else flags.timeout = Math.max(1, Math.floor(n * 1000))
    }
  }
  return { flags, positionals }
}

function ago(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return `il y a ${seconds}s`
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`
  if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)} h`
  return `il y a ${Math.floor(seconds / 86400)} j`
}

function addressOf(agent: AgentRow): string {
  return `${agent.machine}/${agent.thread_id}`
}

function completionOf(agent: AgentRow): string {
  if (agent.completed_at === null) return '-'
  const kind = agent.last_activity === 'edit' ? 'edit' : 'complete'
  return `${ago(agent.completed_at)} (${kind})`
}

function renderTable(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => (row[i] ?? '').length))
  )
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)]
}

function messageLine(message: MessageRow): string {
  const time = new Date(message.created_at).toISOString().slice(11, 19)
  const reply = message.reply_to !== null ? ` re:${message.reply_to}` : ''
  const refs = message.refs.length > 0 ? ` refs=${message.refs.join(',')}` : ''
  const arrow = message.direction === 'out' ? '>' : '<'
  return `#${message.id} ${time} ${arrow} ${message.status}${reply}${refs} ${message.body}`
}

function jsonOut(write: (line: string) => void, value: unknown): void {
  write(JSON.stringify(value))
}

function agentToJson(agent: AgentRow): Record<string, unknown> {
  return {
    address: addressOf(agent),
    name: agent.name,
    state: agent.state,
    working: isWorking(agent.state),
    completion: agent.completed_at === null ? null : { at: agent.completed_at, kind: agent.last_activity },
    paused: agent.state === 'paused',
    archived: agent.state === 'archived',
    projects: agent.projects,
    projectsSuspended: agent.projects_suspended === 1
  }
}

function messageToJson(message: MessageRow): Record<string, unknown> {
  return {
    id: message.id,
    threadId: message.thread_id,
    direction: message.direction,
    status: message.status,
    body: message.body,
    refs: message.refs,
    replyTo: message.reply_to,
    createdAt: message.created_at
  }
}

const HELP = `boite — boîte de coordination d'agents

Adresses : thread-id  (machine locale)
           machine/thread-id

Tâches et ressources partagées uniquement : pas de courtoisie ni de sondage.

Commandes :
  boite agents list [--all] [--json]            état / complétion / pause / archive
  boite agents find <mots...> [--json]          nom, id, adresses et corps de messages
  boite agents read <adresse> [--json]          transcription du fil (marque les entrées lues)
  boite agents send <adresse> <texte...> [--wait] [--ready] [--ref R] [--project P]
  boite agents reply <id> <texte...> [--ref R]  répondre à un message
  boite agents log <adresse> [--limit N] [--follow] [--json]
  boite agents wait <adresse> [--timeout S]     attendre la sortie d'un état de travail

Contrôle :
  boite agents create <nom> [--id ID] [--project P]
  boite agents run <adresse>                    queued -> running
  boite agents done <adresse> [--waiting]       running -> idle (complétion) ou waiting
  boite agents edit <adresse>                   marque une édition (ne compte pas comme complétion)
  boite agents pause|resume <adresse>
  boite agents archive|restore <adresse>

Codes de sortie : 0 ok, 2 usage, 3 refus (courtoisie/archivé/ready), 4 délai, 5 agent inconnu`

type Writer = (line: string) => void

export interface RunOptions {
  out?: Writer
  err?: Writer
}

function printAgentRow(out: Writer, agent: AgentRow): void {
  out(
    [
      addressOf(agent),
      agent.state,
      completionOf(agent),
      agent.state === 'paused' ? 'oui' : '-',
      agent.state === 'archived' ? 'oui' : '-'
    ].join('\t')
  )
}

export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const out: Writer = options.out ?? ((line) => console.log(line))
  const err: Writer = options.err ?? ((line) => console.error(line))

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    out(HELP)
    return 0
  }

  if (argv[0] !== 'agents') {
    throw usageError(`commande inconnue '${argv[0]}' (voir 'boite --help')`)
  }

  const { flags, positionals } = parseArgs(argv.slice(1))
  // `boite agents --help` et `boite agents list --help` doivent afficher l'aide
  // à n'importe quelle position, pas seulement en premier argument.
  if (flags.help) {
    out(HELP)
    return 0
  }
  const command = positionals[0]
  const rest = positionals.slice(1)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(HELP)
    return 0
  }

  const db = openDb()

  switch (command) {
    case 'list': {
      const agents = listAgents(db, { all: flags.all })
      if (flags.json) {
        jsonOut(out, agents.map(agentToJson))
        return 0
      }
      if (agents.length === 0) {
        out('aucun agent')
        return 0
      }
      const rows = agents.map((a) => [
        addressOf(a),
        a.state,
        completionOf(a),
        a.state === 'paused' ? 'oui' : '-',
        a.state === 'archived' ? 'oui' : '-'
      ])
      for (const line of renderTable(['ADRESSE', 'ETAT', 'COMPLETION', 'PAUSE', 'ARCHIVE'], rows)) {
        out(line)
      }
      return 0
    }

    case 'find': {
      if (rest.length === 0) throw usageError('usage : boite agents find <mots...>')
      const results = findAgents(db, rest)
      if (flags.json) {
        jsonOut(
          out,
          results.map((r) => ({ ...agentToJson(r.agent), snippet: r.snippet }))
        )
        return 0
      }
      if (results.length === 0) {
        out('aucun agent')
        return 0
      }
      for (const { agent, snippet } of results) {
        out(`${addressOf(agent)}\t${agent.state}${snippet ? `\t${snippet.slice(0, 80)}` : ''}`)
      }
      return 0
    }

    case 'read': {
      const address = requireOne(rest, 'read')
      const messages = readThread(db, address)
      if (flags.json) {
        jsonOut(out, messages.map(messageToJson))
        return 0
      }
      if (messages.length === 0) {
        out('fil vide')
        return 0
      }
      for (const message of messages) out(messageLine(message))
      return 0
    }

    case 'log': {
      const address = requireOne(rest, 'log')
      const print = (): void => {
        const messages = logThread(db, address, flags.limit)
        if (flags.json) {
          jsonOut(out, messages.map(messageToJson))
          return
        }
        for (const message of messages) out(messageLine(message))
      }
      print()
      if (!flags.follow) return 0
      let seen = logThread(db, address, flags.limit)
      for (;;) {
        await sleep(200)
        const current = logThread(db, address, flags.limit)
        const fresh = current.filter((m) => !seen.some((old) => old.id === m.id))
        for (const message of fresh) out(messageLine(message))
        if (fresh.length > 0) seen = [...seen, ...fresh]
      }
    }

    case 'send': {
      const address = rest[0]
      if (!address) throw usageError('usage : boite agents send <adresse> <texte...>')
      const body = rest.slice(1).join(' ').trim()
      if (body.length === 0) throw usageError('texte manquant')
      const outcome = sendMessage(db, {
        address,
        body,
        refs: flags.refs,
        projects: flags.projects,
        ready: flags.ready
      })
      for (const warning of outcome.warnings) err(`avertissement: ${warning}`)
      let wait: unknown = null
      if (flags.wait) {
        const result = await waitForReply(db, address, {
          afterId: outcome.message.id,
          ...(flags.timeout !== null ? { timeoutMs: flags.timeout } : {})
        })
        wait = result
        err(`attente terminée: ${result.reason} (état ${result.state})`)
      }
      if (flags.json) {
        jsonOut(out, {
          id: outcome.message.id,
          status: outcome.message.status,
          held: outcome.held,
          warnings: outcome.warnings,
          wait
        })
        return 0
      }
      const verb = outcome.held ? 'retenu' : 'livré'
      out(`#${outcome.message.id} ${verb} vers ${address}`)
      if (flags.wait && wait) out(`attente: ${(wait as { reason: string }).reason}`)
      return 0
    }

    case 'reply': {
      const idText = rest[0]
      if (!idText) throw usageError('usage : boite agents reply <id> <texte...>')
      const messageId = Number(idText)
      if (!Number.isInteger(messageId)) throw usageError(`identifiant de message invalide : '${idText}'`)
      const body = rest.slice(1).join(' ').trim()
      if (body.length === 0) throw usageError('texte manquant')
      const outcome = replyMessage(db, { messageId, body, refs: flags.refs, ready: flags.ready })
      for (const warning of outcome.warnings) err(`avertissement: ${warning}`)
      if (flags.json) {
        jsonOut(out, {
          id: outcome.message.id,
          status: outcome.message.status,
          held: outcome.held,
          warnings: outcome.warnings
        })
        return 0
      }
      const verb = outcome.held ? 'retenu' : 'livré'
      out(`#${outcome.message.id} ${verb} en réponse à #${messageId}`)
      return 0
    }

    case 'wait': {
      const address = requireOne(rest, 'wait')
      const opts = flags.timeout !== null ? { timeoutMs: flags.timeout } : {}
      const result = await waitForState(db, address, opts)
      if (flags.json) {
        jsonOut(out, result)
        return 0
      }
      out(`état: ${result.state}`)
      return 0
    }

    case 'create': {
      const name = rest.join(' ').trim()
      if (name.length === 0) throw usageError('usage : boite agents create <nom> [--id ID]')
      const agent = createAgent(db, {
        name,
        ...(flags.id !== null ? { threadId: flags.id } : {}),
        projects: flags.projects
      })
      if (flags.json) {
        jsonOut(out, agentToJson(agent))
        return 0
      }
      out(`${addressOf(agent)}  créé (${agent.name})`)
      return 0
    }

    case 'run':
    case 'done':
    case 'edit':
    case 'pause':
    case 'resume':
    case 'archive':
    case 'restore': {
      const address = requireOne(rest, command)
      const updated =
        command === 'run'
          ? runAgent(db, address)
          : command === 'done'
            ? doneAgent(db, address, { waiting: flags.waiting })
            : command === 'edit'
              ? editAgent(db, address)
              : command === 'pause'
                ? pauseAgent(db, address)
                : command === 'resume'
                  ? resumeAgent(db, address)
                  : command === 'archive'
                    ? archiveAgent(db, address)
                    : restoreAgent(db, address)
      if (flags.json) {
        jsonOut(out, agentToJson(updated))
        return 0
      }
      printAgentRow(out, updated)
      return 0
    }

    default:
      throw usageError(`sous-commande inconnue '${command}' (voir 'boite agents --help')`)
  }
}

function requireOne(rest: string[], command: string): string {
  const value = rest[0]
  if (!value) throw usageError(`usage : boite agents ${command} <adresse>`)
  if (rest.length > 1) throw usageError(`argument en trop après '${value}'`)
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isMain()) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      if (error instanceof BoiteError) {
        console.error(`boite: ${error.code}: ${error.message}`)
        process.exitCode = error.exitCode
      } else {
        console.error(`boite: ${String(error)}`)
        process.exitCode = 1
      }
    })
}
