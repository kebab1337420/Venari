// Retire du catalogue les entrées qui n'ont rien à voir avec le bug bounty
// (logiciels générateurs, navigateurs, IDE, runtimes multiples, IaC, cloud,
// remote desktop, messageries...). Usage : node scripts/prune-catalog.cjs
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'src', 'main', 'services', 'tools', 'catalog.ts')

// Passe 2 : hors web bug bounty — post-exploitation AD/Windows, DFIR/maliciel,
// cracking, RE, capture/CNF réseau profonde, scan internet-wide.
const REMOVE = new Set([
  // post-exploitation AD / Windows
  'impacket', 'responder', 'evil-winrm', 'nishang', 'empire', 'powersploit', 'seatbelt',
  'rubeus', 'bloodhound', 'sharphound', 'mimikatz', 'petitpotam', 'printspoofer',
  'unicorn', 'sliver', 'velociraptor', 'metasploit',
  // DFIR / maliciel / threat intel
  'volatility', 'volatility3', 'timesketch', 'assemblyline', 'yara', 'clamav', 'capa',
  'ptf', 'capev2', 'misp', 'opencti', 'yeti', 'mitre-attack', 'mitre-cti',
  // cracking
  'hashcat', 'john',
  // reverse engineering
  'radare2',
  // capture / analyse de trafic profonde
  'tcpdump', 'ngrep', 'zeek', 'suricata', 'arkime', 'ntopng', 'scapy',
  // scan internet-wide (hors scope de programme)
  'zmap', 'zgrab2'
])

const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/)
const out = []
let i = 0
let removed = 0
while (i < lines.length) {
  if (lines[i] === '  {' && lines[i + 1] && /^\s{4}id: '[^']+',?$/.test(lines[i + 1])) {
    // trouve la fin de l'entree (  }, )
    let j = i
    while (j < lines.length && lines[j] !== '  },') j++
    const id = lines[i + 1].match(/id: '([^']+)'/)[1]
    if (REMOVE.has(id)) {
      removed++
      i = j + 1 // saute l'entiere
      continue
    }
  }
  out.push(lines[i])
  i++
}

fs.writeFileSync(FILE, out.join('\n'), 'utf8')
console.log(`entrees retirees : ${removed} / ${REMOVE.size}`)
if (removed !== REMOVE.size) {
  console.error(`ATTENTION : ${REMOVE.size - removed} ids non trouves dans le fichier`)
  process.exitCode = 1
}
