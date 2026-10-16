export type ToolCategory = 'recon' | 'enumer' | 'fuzz' | 'network' | 'utility' | 'ai'

export interface ToolDefinition {
  id: string
  name: string
  description: string
  category: ToolCategory
  source: 'winget' | 'github' | 'git' | 'pip' | 'go'
  wingetId?: string
  githubRepo?: string
  githubAsset?: string
  detectCmd?: string
  /** Fragment de nom d'asset pour la cible Linux (par défaut githubAsset). */
  githubAssetLinux?: string
  /** Nom réel du binaire dans l'archive quand il diffère de l'id. */
  exeName?: string
  /**
   * Module Go installé par `go install <module>@latest` quand source === 'go'.
   * Le binaire est déposé dans un dossier isolé tools/<id> (GOBIN), comme pour
   * pip : rien n'atteint le GOPATH global de l'utilisateur.
   */
  goPackage?: string
  /** Paquet Debian/Ubuntu pour installer cet outil sous Linux. */
  aptPackage?: string
  /**
   * Nom de la distribution PyPI quand source === 'pip'. L'installation passe
   * par un venv isolé sous tools/<id> : aucune dépendance n'est injectée dans
   * l'interpréteur système.
   */
  pipPackage?: string
  /** Outil sans équivalent hors Windows (Sysinternals, PowerToys...). */
  windowsOnly?: boolean
  /** Application graphique : installation hors périmètre d'un utilitaire CLI. */
  guiOnly?: boolean
  defaultChecked: boolean
}

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: 'nmap',
    name: 'Nmap',
    description: 'Scan réseau et détection de services, scripts NSE',
    category: 'network',
    source: 'winget',
    wingetId: 'Insecure.Nmap',
    aptPackage: 'nmap',
    defaultChecked: true
  },
  {
    id: 'wireshark',
    name: 'Wireshark',
    description: 'Analyse de trafic réseau (pcap, protocoles)',
    category: 'network',
    source: 'winget',
    wingetId: 'WiresharkFoundation.Wireshark',
    aptPackage: 'wireshark',
    detectCmd: 'tshark',
    defaultChecked: false
  },
  {
    id: 'nuclei',
    name: 'Nuclei',
    description: 'Scanner de vulnérabilités par templates (ProjectDiscovery)',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/nuclei',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: true
  },
  {
    id: 'subfinder',
    name: 'Subfinder',
    description: 'Découverte de sous-domaines passifs',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/subfinder',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: true
  },
  {
    id: 'httpx',
    name: 'httpx',
    description: 'Probing HTTP : titres, status, technologies, fingerprints',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/httpx',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: true
  },
  {
    id: 'katana',
    name: 'Katana',
    description: 'Crawler web de ProjectDiscovery (simple et headless)',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/katana',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'naabu',
    name: 'Naabu',
    description: 'Découverte de ports rapide (ProjectDiscovery)',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/naabu',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'dnsx',
    name: 'dnsx',
    description: 'Boîte à outils DNS pour l’énumération (ProjectDiscovery)',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/dnsx',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'asnmap',
    name: 'asnmap',
    description: 'Mapping ASN/organisation → plages IP (ProjectDiscovery)',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/asnmap',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'uncover',
    name: 'uncover',
    description: 'Recherche de services via les moteurs Shodan/Censys/Fofa',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/uncover',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'alterx',
    name: 'alterx',
    description: 'Génération de permutations de sous-domaines (ProjectDiscovery)',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/alterx',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'amass',
    name: 'Amass',
    description: 'Énumération de sous-domaines OWASP (passive + actif)',
    category: 'recon',
    source: 'github',
    githubRepo: 'OWASP/amass',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'aquatone',
    name: 'Aquatone',
    description: 'Capture de screenshots à grande échelle + visualisation',
    category: 'recon',
    source: 'github',
    githubRepo: 'michenriksen/aquatone',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'waybackurls',
    name: 'waybackurls',
    description: 'Extrait les URLs de l’archive Wayback Machine',
    category: 'recon',
    source: 'github',
    githubRepo: 'tomnomnom/waybackurls',
    githubAsset: 'windows-amd64',
    githubAssetLinux: 'linux-amd64',
    defaultChecked: false
  },
  {
    id: 'tlsx',
    name: 'tlsx',
    description: 'Collecte TLS : certificats, SNI, versions, jarm',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/tlsx',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'chaos',
    name: 'Chaos',
    description: 'Fuzzing et résolution DNS via les datasets ProjectDiscovery',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/chaos-client',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    exeName: 'chaos-client',
    defaultChecked: false
  },
  {
    id: 'mapcidr',
    name: 'mapcidr',
    description: 'Conversion et manipulation de plages CIDR / IP',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/mapcidr',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'cdncheck',
    name: 'cdncheck',
    description: 'Détection des CDN et WAF connus sur une cible',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/cdncheck',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'urlfinder',
    name: 'urlfinder',
    description: 'Découverte rapide d’URLs sur un domaine',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/urlfinder',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'shuffledns',
    name: 'shuffledns',
    description: 'Résolution DNS massive avec bruteforce de sous-domaines',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/shuffledns',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'cloudlist',
    name: 'cloudlist',
    description: 'Liste des domaines hébergés chez les fournisseurs cloud',
    category: 'recon',
    source: 'github',
    githubRepo: 'projectdiscovery/cloudlist',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'gau',
    name: 'gau',
    description: 'Récupère les URL archivées (Wayback, Common Crawl, AlienVault)',
    category: 'recon',
    source: 'github',
    githubRepo: 'lc/gau',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'cariddi',
    name: 'cariddi',
    description: 'Crawl de masse : endpoints, secrets, tokens, extensions',
    category: 'recon',
    source: 'github',
    githubRepo: 'edoardottt/cariddi',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'httprobe',
    name: 'httprobe',
    description: 'Sonde HTTP : statut, titres, technologies, favicon hash',
    category: 'recon',
    source: 'github',
    githubRepo: 'tomnomnom/httprobe',
    githubAsset: 'windows-amd64',
    githubAssetLinux: 'linux-amd64',
    defaultChecked: false
  },
  {
    id: 'unfurl',
    name: 'unfurl',
    description: 'Extrait et normalise les données d’une URL',
    category: 'recon',
    source: 'github',
    githubRepo: 'tomnomnom/unfurl',
    githubAsset: 'windows-amd64',
    githubAssetLinux: 'linux-amd64',
    defaultChecked: false
  },
  {
    id: 'findomain',
    name: 'Findomain',
    description: 'Découverte de sous-domaines multi-source, active et passive',
    category: 'recon',
    source: 'github',
    githubRepo: 'findomain/findomain',
    githubAsset: 'findomain-windows',
    githubAssetLinux: 'findomain-linux.zip',
    defaultChecked: false
  },
  {
    id: 'puredns',
    name: 'puredns',
    description: 'Résolution DNS massive via resolvers publics et tranco',
    category: 'recon',
    source: 'git',
    githubRepo: 'd3mondev/puredns',
    defaultChecked: false
  },
  {
    id: 'github-subdomains',
    name: 'GitHub Subdomains',
    description: 'Trouve des sous-domaines dans le code source public GitHub',
    category: 'recon',
    source: 'git',
    githubRepo: 'gwen001/github-subdomains',
    defaultChecked: false
  },
  {
    id: 'github-endpoints',
    name: 'GitHub Endpoints',
    description: 'Détecte les endpoints exposés dans les dépôts GitHub',
    category: 'recon',
    source: 'git',
    githubRepo: 'gwen001/github-endpoints',
    defaultChecked: false
  },
  {
    id: 'gauplus',
    name: 'gauplus',
    description: 'Wrapper de gau avec vérification des URLs via Check-Host',
    category: 'recon',
    source: 'go',
    githubRepo: 'bp0lr/gauplus',
    goPackage: 'github.com/bp0lr/gauplus',
    defaultChecked: false
  },
  {
    id: 'theharvester',
    name: 'theHarvester',
    description: 'OSINT : sous-domaines, adresses e-mail, noms, hôtes',
    category: 'recon',
    source: 'git',
    githubRepo: 'laramies/theHarvester',
    defaultChecked: false
  },
  {
    id: 'sublist3r',
    name: 'Sublist3r',
    description: 'Énumération de sous-domaines via plusieurs sources',
    category: 'recon',
    source: 'git',
    githubRepo: 'aboul3la/Sublist3r',
    defaultChecked: false
  },
  {
    id: 'oneforall',
    name: 'OneForAll',
    description: 'OSINT mono-outil : sous-domaines, e-mails, IRC, repositories',
    category: 'recon',
    source: 'git',
    githubRepo: 'shmilylty/OneForAll',
    defaultChecked: false
  },
  {
    id: 'sherlock',
    name: 'Sherlock',
    description: 'Recherche de comptes existants à partir d’un pseudo',
    category: 'recon',
    source: 'git',
    githubRepo: 'sherlock-project/sherlock',
    defaultChecked: false
  },
  {
    id: 'maigret',
    name: 'Maigret',
    description: 'OSINT : présence d’un identifiant sur des dizaines de réseaux',
    category: 'recon',
    source: 'git',
    githubRepo: 'soxoj/maigret',
    defaultChecked: false
  },
  {
    id: 'ghunt',
    name: 'GHunt',
    description: 'Enquête OSINT sur un compte Google : e-mails, clés, services',
    category: 'recon',
    source: 'git',
    githubRepo: 'mxrch/GHunt',
    defaultChecked: false
  },
  {
    id: 'osintgram',
    name: 'Osintgram',
    description: 'Modules OSINT ciblés sur un compte Instagram',
    category: 'recon',
    source: 'git',
    githubRepo: 'Datalux/Osintgram',
    defaultChecked: false
  },
  {
    id: 'recon-ng',
    name: 'recon-ng',
    description: 'Framework de reconnaissance modulaire et orienté OSINT',
    category: 'recon',
    source: 'git',
    githubRepo: 'lanmaster53/recon-ng',
    defaultChecked: false
  },
  {
    id: 'reconftw',
    name: 'reconFTW',
    description: 'Orchestrateur de reconnaissance OSINT de bout en bout',
    category: 'recon',
    source: 'git',
    githubRepo: 'six2dez/reconftw',
    defaultChecked: false
  },
  {
    id: 'spiderfoot',
    name: 'SpiderFoot',
    description: 'Footprinting et collecte OSINT automatisée multilingue',
    category: 'recon',
    source: 'git',
    githubRepo: 'smicallef/spiderfoot',
    defaultChecked: false
  },
  {
    id: 'wafw00f',
    name: 'wafw00f',
    description: 'Identifie les pare-feu applicatifs devant une cible',
    category: 'recon',
    source: 'git',
    githubRepo: 'EnableSecurity/wafw00f',
    defaultChecked: false
  },
  {
    id: 'whatweb',
    name: 'WhatWeb',
    description: 'Fingerprint de sites : CMS, frameworks, libs, emails',
    category: 'recon',
    source: 'git',
    githubRepo: 'urbanadventurer/WhatWeb',
    defaultChecked: false
  },
  {
    id: 'paramspider',
    name: 'ParamSpider',
    description: 'Découvre les paramètres d’URL à partir des journaux de recherche',
    category: 'recon',
    source: 'git',
    githubRepo: 'devanshbatham/ParamSpider',
    defaultChecked: false
  },
  {
    id: 'gospider',
    name: 'gospider',
    description: 'Crawler web rapide en Go (endpoints, JS, formulaires)',
    category: 'recon',
    source: 'go',
    githubRepo: 'jaeles-project/gospider',
    goPackage: 'github.com/jaeles-project/gospider',
    defaultChecked: false
  },
  {
    id: 'jsluice',
    name: 'jsluice',
    description: 'Extrait URLs, chemins et secrets depuis des fichiers JavaScript',
    category: 'recon',
    source: 'git',
    githubRepo: 'BishopFox/jsluice',
    defaultChecked: false
  },
  {
    id: 'cloud-enum',
    name: 'cloud_enum',
    description: 'Énumère les ressources publiques AWS, Azure et Google Cloud',
    category: 'recon',
    source: 'git',
    githubRepo: 'initstring/cloud_enum',
    defaultChecked: false
  },
  {
    id: 'cloudfox',
    name: 'cloudfox',
    description: 'Cherche les données exposées et les permissions laxistes dans AWS, Azure et GCP',
    category: 'recon',
    source: 'github',
    githubRepo: 'BishopFox/cloudfox',
    githubAsset: 'windows-amd64',
    githubAssetLinux: 'linux-amd64',
    defaultChecked: false
  },
  {
    id: 's3scanner',
    name: 'S3Scanner',
    description: 'Cherche des buckets S3 mal configurés sur les API compatibles',
    category: 'recon',
    source: 'git',
    githubRepo: 'Sa7mon/S3Scanner',
    defaultChecked: false
  },
  {
    id: 'linkfinder',
    name: 'LinkFinder',
    description: 'Extrait endpoints et secrets des fichiers JavaScript et CSS',
    category: 'recon',
    source: 'git',
    githubRepo: 'GerbenJavado/LinkFinder',
    defaultChecked: false
  },
  {
    id: 'secretfinder',
    name: 'SecretFinder',
    description: 'Trouve des secrets dans les pages web et les archives ZIP',
    category: 'recon',
    source: 'git',
    githubRepo: 'm4ll0k/SecretFinder',
    defaultChecked: false
  },
  {
    id: 'hakrawler',
    name: 'hakrawler',
    description: 'Crawler OSINT : e-mails, comptes, dépôts, usernames',
    category: 'recon',
    source: 'go',
    githubRepo: 'hakluke/hakrawler',
    goPackage: 'github.com/hakluke/hakrawler',
    defaultChecked: false
  },
  {
    id: 'hakrevdns',
    name: 'hakrevdns',
    description: 'Enregistrement d’cran pour la preuve d’une reproduction',
    category: 'recon',
    source: 'git',
    githubRepo: 'hakluke/hakrevdns',
    defaultChecked: false
  },
  {
    id: 'hakoriginfinder',
    name: 'hakoriginfinder',
    description: 'Trouve adresses e-mail et noms avec des dorks OSINT',
    category: 'recon',
    source: 'git',
    githubRepo: 'hakluke/hakoriginfinder',
    defaultChecked: false
  },
  {
    id: 'hakcheckurl',
    name: 'hakcheckurl',
    description: 'Vérifie le statut HTTP et les redirections d’une liste d’URL',
    category: 'recon',
    source: 'git',
    githubRepo: 'hakluke/hakcheckurl',
    defaultChecked: false
  },
  {
    id: 'haktrails',
    name: 'haktrails',
    description: 'Historique des sous-domaines via l’API SecurityTrails',
    category: 'recon',
    source: 'go',
    githubRepo: 'hakluke/haktrails',
    goPackage: 'github.com/hakluke/haktrails',
    defaultChecked: false
  },
  {
    id: 'assetfinder',
    name: 'assetfinder',
    description: 'Sous-domaines et IPs extraits de l’historique GitHub',
    category: 'recon',
    source: 'git',
    githubRepo: 'tomnomnom/assetfinder',
    defaultChecked: false
  },
  {
    id: 'onelistforall',
    name: 'OneListForAll',
    description: 'Génère des listes de sous-domaines depuis plusieurs sources',
    category: 'recon',
    source: 'git',
    githubRepo: 'six2dez/OneListForAll',
    defaultChecked: false
  },
  {
    id: 'bbot',
    name: 'BBOT',
    description: 'Scanner OSINT récursif modulaire (Python)',
    category: 'recon',
    source: 'git',
    githubRepo: 'blacklanternsecurity/bbot',
    defaultChecked: false
  },
  {
    id: 'ffuf',
    name: 'ffuf',
    description: 'Fuzzing web : répertoires, paramètres, vhosts',
    category: 'fuzz',
    source: 'winget',
    wingetId: 'ffuf.ffuf',
    aptPackage: 'ffuf',
    defaultChecked: true
  },
  {
    id: 'gobuster',
    name: 'Gobuster',
    description: 'Bruteforce de répertoires, DNS et vhosts',
    category: 'fuzz',
    source: 'github',
    githubRepo: 'OJ/gobuster',
    githubAsset: 'windows_x86_64',
    githubAssetLinux: 'Linux_x86_64',
    defaultChecked: true
  },
  {
    id: 'dalfox',
    name: 'dalfox',
    description: 'Scanner de XSS (paramètre, mutation, DOM)',
    category: 'fuzz',
    source: 'github',
    githubRepo: 'hahwul/dalfox',
    githubAsset: 'windows-x86_64',
    githubAssetLinux: 'linux-x86_64.tar.gz',
    defaultChecked: false
  },
  {
    id: 'feroxbuster',
    name: 'feroxbuster',
    description: 'Bruteforce de répertoires rapide (Rust, multi-thread)',
    category: 'fuzz',
    source: 'github',
    githubRepo: 'epi052/feroxbuster',
    githubAsset: 'x86_64-windows-feroxbuster',
    githubAssetLinux: 'x86_64-linux-feroxbuster.zip',
    defaultChecked: false
  },
  {
    id: 'crlfuzz',
    name: 'crlfuzz',
    description: 'Détecte les injections CRLF sur paramètres et endpoints HTTP',
    category: 'fuzz',
    source: 'github',
    githubRepo: 'dwisiswant0/crlfuzz',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'brutespray',
    name: 'brutespray',
    description: 'Spray de mots de passe sur SSH, FTP, SMB et autres services',
    category: 'fuzz',
    source: 'github',
    githubRepo: 'x90skysn3k/brutespray',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'sqlmap',
    name: 'sqlmap',
    description: 'Détection et exploitation d’injections SQL',
    category: 'fuzz',
    source: 'git',
    githubRepo: 'sqlmapproject/sqlmap',
    defaultChecked: false
  },
  {
    id: 'dirsearch',
    name: 'dirsearch',
    description: 'Bruteforce web de répertoires (multi-thread, wordlists)',
    category: 'fuzz',
    source: 'git',
    githubRepo: 'maurosoria/dirsearch',
    defaultChecked: false
  },
  {
    id: 'arjun',
    name: 'Arjun',
    description: 'Découvre les paramètres cachés d’un endpoint',
    category: 'fuzz',
    source: 'git',
    githubRepo: 's0md3v/Arjun',
    defaultChecked: false
  },
  {
    id: 'xsstrike',
    name: 'XSStrike',
    description: 'Détection de XSS avec analyse de contexte et payloads',
    category: 'fuzz',
    source: 'git',
    githubRepo: 's0md3v/XSStrike',
    defaultChecked: false
  },
  {
    id: 'commix',
    name: 'commix',
    description: 'Fuzzer d’injections (SQL, NoSQL, LDAP, OS command…)',
    category: 'fuzz',
    source: 'git',
    githubRepo: 'commixproject/commix',
    defaultChecked: false
  },
  {
    id: 'nosqlmap',
    name: 'NoSQLMap',
    description: 'Fuzzer d’injections pour bases de données NoSQL',
    category: 'fuzz',
    source: 'git',
    githubRepo: 'codingo/NoSQLMap',
    defaultChecked: false
  },
  {
    id: 'jaeles',
    name: 'jaeles',
    description: 'Fuzzing de requêtes piloté par des signatures JSON',
    category: 'fuzz',
    source: 'git',
    githubRepo: 'jaeles-project/jaeles',
    defaultChecked: false
  },
  {
    id: 'nikto',
    name: 'Nikto',
    description: 'Scanner web de vulnérabilités et configurations par défaut',
    category: 'enumer',
    source: 'git',
    githubRepo: 'sullo/nikto',
    defaultChecked: false
  },
  {
    id: 'interlace',
    name: 'Interlace',
    description: 'Automatise des commandes sur un ensemble de cibles',
    category: 'enumer',
    source: 'git',
    githubRepo: 'codingo/Interlace',
    defaultChecked: false
  },
  {
    id: 'wpscan',
    name: 'WPScan',
    description: 'Énumération de WordPress : thèmes, plugins, failles connues',
    category: 'enumer',
    source: 'git',
    githubRepo: 'wpscanteam/wpscan',
    defaultChecked: false
  },
  {
    id: 'cmsseek',
    name: 'CMSeek',
    description: 'Détection et analyse de 180+ CMS (WordPress, Joomla, Drupal…)',
    category: 'enumer',
    source: 'git',
    githubRepo: 'Tuhinshubhra/CMSeek',
    defaultChecked: false
  },
  {
    id: 'joomscan',
    name: 'joomscan',
    description: 'Scanner de vulnérabilités Joomla (OWASP)',
    category: 'enumer',
    source: 'git',
    githubRepo: 'OWASP/joomscan',
    defaultChecked: false
  },
  {
    id: 'droopescan',
    name: 'Droopescan',
    description: 'Énumération de modules et de thèmes Drupal vulnérables',
    category: 'enumer',
    source: 'git',
    githubRepo: 'SamJoan/droopescan',
    defaultChecked: false
  },
  {
    id: 'wapiti',
    name: 'Wapiti',
    description: 'Scanner web de vulnérabilités (rapports, crawl, OWASP)',
    category: 'enumer',
    source: 'git',
    githubRepo: 'wapiti-scanner/wapiti',
    defaultChecked: false
  },
  {
    id: 'openvas-scanner',
    name: 'OpenVAS Scanner',
    description: 'Moteur de scan de vulnérabilités (Greenbone)',
    category: 'enumer',
    source: 'git',
    githubRepo: 'greenbone/openvas-scanner',
    defaultChecked: false
  },
  {
    id: 'zaproxy',
    name: 'OWASP ZAP (source)',
    description: 'Code source du proxy ZAP (DAST), à installer via la Community Edition',
    category: 'enumer',
    source: 'git',
    githubRepo: 'zaproxy/zaproxy',
    defaultChecked: false
  },
  {
    id: 'interactsh-client',
    name: 'interactsh-client',
    description: 'Client OAST interactsh (détection d’appels sortants, SSRF, blind)',
    category: 'network',
    source: 'github',
    githubRepo: 'projectdiscovery/interactsh',
    githubAsset: 'client',
    defaultChecked: false
  },
  {
    id: 'notify',
    name: 'notify',
    description: 'Notifications OAST vers Discord, Slack, Telegram ou webhook',
    category: 'network',
    source: 'github',
    githubRepo: 'projectdiscovery/notify',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'simplehttpserver',
    name: 'simplehttpserver',
    description: 'Serveur HTTP local pour canary tokens et tests OAST',
    category: 'network',
    source: 'github',
    githubRepo: 'projectdiscovery/simplehttpserver',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'pdtm',
    name: 'pdtm',
    description: 'Proxy qui tente les ports et mots de passe détectés par un scan',
    category: 'network',
    source: 'github',
    githubRepo: 'projectdiscovery/pdtm',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'chisel',
    name: 'chisel',
    description: 'Tunnel TCP/UDP chiffré pour pivoter dans un réseau interne',
    category: 'network',
    source: 'github',
    githubRepo: 'jpillora/chisel',
    githubAsset: 'windows_amd64',
    windowsOnly: true,
    defaultChecked: false
  },
  {
    id: 'bettercap',
    name: 'bettercap',
    description: 'Attaques réseau : MITM, spoofing, Wi-Fi, poisoning',
    category: 'network',
    source: 'github',
    githubRepo: 'bettercap/bettercap',
    githubAsset: 'bettercap_windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'rustscan',
    name: 'rustscan',
    description: 'Scanner de ports TCP ultra rapide (pivoter ensuite avec nmap)',
    category: 'network',
    source: 'github',
    githubRepo: 'RustScan/RustScan',
    githubAsset: 'x86_64-windows-rustscan',
    githubAssetLinux: 'x86_64-linux-rustscan.tar.gz.zip',
    defaultChecked: false
  },
  {
    id: 'nmap-source',
    name: 'Nmap (source)',
    description: 'Code source de Nmap, pour compiler une version personnalisée',
    category: 'network',
    source: 'git',
    githubRepo: 'nmap/nmap',
    defaultChecked: false
  },
  {
    id: 'masscan',
    name: 'masscan',
    description: 'Scanner de ports asynchrone, très rapide sur de grandes plages',
    category: 'network',
    source: 'git',
    githubRepo: 'robertdavidgraham/masscan',
    defaultChecked: false
  },
  {
    id: 'frp',
    name: 'frp',
    description: 'Reverse proxy pour exposer un service local derrière un NAT',
    category: 'network',
    source: 'git',
    githubRepo: 'fatedier/frp',
    defaultChecked: false
  },
  {
    id: 'gost',
    name: 'gost',
    description: 'Tunnel multi-protocole simple et flexible (TCP, UDP, HTTP, QUIC)',
    category: 'network',
    source: 'git',
    githubRepo: 'go-gost/gost',
    defaultChecked: false
  },
  {
    id: 'nps',
    name: 'nps',
    description: 'Serveur de tunnel d’intranet (TCP, UDP, HTTP, SOCKS5) avec panel web',
    category: 'network',
    source: 'git',
    githubRepo: 'ehang-io/nps',
    defaultChecked: false
  },
  {
    id: 'mitmproxy',
    name: 'mitmproxy',
    description: 'Proxy interactif avec scriptable flows HTTP/HTTPS',
    category: 'network',
    source: 'git',
    githubRepo: 'mitmproxy/mitmproxy',
    defaultChecked: false
  },
  {
    id: 'http-toolkit',
    name: 'HTTP Toolkit',
    description: 'Proxy et intercepteur HTTP(S) avec interface graphique, multi-plateforme',
    category: 'network',
    source: 'git',
    githubRepo: 'httptoolkit/httptoolkit',
    defaultChecked: false
  },
  {
    id: 'jq',
    name: 'jq',
    description: 'Manipulation JSON dans le terminal',
    category: 'utility',
    source: 'winget',
    wingetId: 'jqlang.jq',
    aptPackage: 'jq',
    defaultChecked: false
  },
  {
    id: 'ripgrep',
    name: 'ripgrep',
    description: 'Recherche de motifs ultra rapide dans les fichiers',
    category: 'utility',
    source: 'winget',
    wingetId: 'BurntSushi.ripgrep.GNU',
    aptPackage: 'ripgrep',
    detectCmd: 'rg',
    defaultChecked: false
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Versioning et clonage de wordlists/templates',
    category: 'utility',
    source: 'winget',
    wingetId: 'Git.Git',
    aptPackage: 'git',
    defaultChecked: false
  },
  {
    id: 'python',
    name: 'Python 3.12',
    description: 'Runtime pour vos scripts d’analyse',
    category: 'utility',
    source: 'winget',
    wingetId: 'Python.Python.3.12',
    aptPackage: 'python3-minimal',
    detectCmd: 'python3',
    defaultChecked: false
  },
  {
    id: 'go',
    name: 'Go',
    description: 'Runtime Go : permet de `go install` les petits outils de la communauté',
    category: 'utility',
    source: 'winget',
    wingetId: 'GoLang.Go',
    aptPackage: 'golang-go',
    defaultChecked: false
  },
  {
    id: 'node',
    name: 'Node.js LTS',
    description: 'Runtime JavaScript pour vos scripts d’analyse',
    category: 'utility',
    source: 'winget',
    wingetId: 'OpenJS.NodeJS.LTS',
    aptPackage: 'nodejs',
    defaultChecked: false
  },
  {
    id: 'uv',
    name: 'uv',
    description: 'Gestionnaire Python ultra rapide (venv et dépendances)',
    category: 'utility',
    source: 'winget',
    wingetId: 'astral-sh.uv',
    detectCmd: 'uv',
    defaultChecked: false
  },
  {
    id: 'yq',
    name: 'yq',
    description: 'Manipulation YAML (analogue à jq)',
    category: 'utility',
    source: 'winget',
    wingetId: 'MikeFarah.yq',
    detectCmd: 'yq',
    defaultChecked: false
  },
  {
    id: 'gitleaks',
    name: 'gitleaks',
    description: 'Détection de secrets dans un dépôt git',
    category: 'utility',
    source: 'github',
    githubRepo: 'gitleaks/gitleaks',
    githubAsset: 'windows_x64',
    githubAssetLinux: 'linux_x64',
    defaultChecked: false
  },
  {
    id: 'trufflehog',
    name: 'trufflehog',
    description: 'Détection de secrets, y compris dans l’historique git',
    category: 'utility',
    source: 'github',
    githubRepo: 'trufflesecurity/trufflehog',
    githubAsset: 'windows_amd64',
    githubAssetLinux: 'linux_amd64',
    defaultChecked: false
  },
  {
    id: 'noseyparker',
    name: 'Nosey Parker',
    description: 'Trouve secrets et données sensibles dans fichiers et historiques git',
    category: 'utility',
    source: 'git',
    githubRepo: 'praetorian-inc/noseyparker',
    defaultChecked: false
  },
  {
    id: 'meg',
    name: 'meg',
    description: 'Fuzzing massif de sous-domaines (chaînes alphanumériques)',
    category: 'utility',
    source: 'github',
    githubRepo: 'tomnomnom/meg',
    githubAsset: 'windows-amd64',
    githubAssetLinux: 'linux-amd64',
    defaultChecked: false
  },
  {
    id: 'qsreplace',
    name: 'qsreplace',
    description: 'Remplace les valeurs de requête et de cookie dans un fichier Burp',
    category: 'utility',
    source: 'github',
    githubRepo: 'tomnomnom/qsreplace',
    githubAsset: 'windows-amd64',
    githubAssetLinux: 'linux-amd64',
    defaultChecked: false
  },
  {
    id: 'anew',
    name: 'anew',
    description: 'Ajoute les lignes nouvelles d’un flux en ignorant les doublons',
    category: 'utility',
    source: 'github',
    githubRepo: 'tomnomnom/anew',
    githubAsset: 'windows-amd64',
    githubAssetLinux: 'linux-amd64',
    defaultChecked: false
  },
  {
    id: 'gron',
    name: 'gron',
    description: 'Transforme du JSON en lignes-plate pour grep et awk',
    category: 'utility',
    source: 'github',
    githubRepo: 'tomnomnom/gron',
    githubAsset: 'windows-amd64',
    githubAssetLinux: 'linux-amd64',
    defaultChecked: false
  },
  {
    id: 'gf',
    name: 'gf',
    description: 'Patterns grep pour tokens, XSS, SQLi, LFI et plus',
    category: 'utility',
    source: 'git',
    githubRepo: 'tomnomnom/gf',
    defaultChecked: false
  },
  {
    id: 'fff',
    name: 'fff',
    description: 'Trouve rapidement les fichiers volumineux dans une arborescence',
    category: 'utility',
    source: 'go',
    githubRepo: 'tomnomnom/fff',
    goPackage: 'github.com/tomnomnom/fff',
    defaultChecked: false
  },
  {
    id: 'osv-scanner',
    name: 'OSV-Scanner',
    description: 'Scan de vulnérabilités des dépendances via la base osv.dev',
    category: 'utility',
    source: 'git',
    githubRepo: 'google/osv-scanner',
    defaultChecked: false
  },
  {
    id: 'pip-audit',
    name: 'pip-audit',
    description: 'Audit des dépendances Python et de leurs vulnérabilités connues',
    category: 'utility',
    source: 'git',
    githubRepo: 'pypa/pip-audit',
    defaultChecked: false
  },
  {
    id: 'retirejs',
    name: 'Retire.js',
    description: 'Détecte les bibliothèques JavaScript vulnérables et génère un SBOM',
    category: 'utility',
    source: 'git',
    githubRepo: 'RetireJS/retire.js',
    defaultChecked: false
  },
  {
    id: 'dependency-check',
    name: 'OWASP Dependency-Check',
    description: 'Analyse SCA des dépendances (Java, .NET, Node, Python…)',
    category: 'utility',
    source: 'git',
    githubRepo: 'jeremylong/DependencyCheck',
    defaultChecked: false
  },
  {
    id: 'owasp-cheatsheets',
    name: 'OWASP Cheat Sheet Series',
    description: 'Guides de sécurisation par technologie, en Markdown',
    category: 'utility',
    source: 'git',
    githubRepo: 'OWASP/CheatSheetSeries',
    defaultChecked: false
  },
  {
    id: 'owasp-asvs',
    name: 'OWASP ASVS',
    description: 'Standard de vérification de sécurité applicative',
    category: 'utility',
    source: 'git',
    githubRepo: 'OWASP/ASVS',
    defaultChecked: false
  },
  {
    id: 'owasp-wstg',
    name: 'OWASP WSTG',
    description: 'Guide de test de sécurité des applications web',
    category: 'utility',
    source: 'git',
    githubRepo: 'OWASP/wstg',
    defaultChecked: false
  },
  {
    id: 'owasp-mastg',
    name: 'OWASP MASTG',
    description: 'Guide de test et de reverse engineering mobile',
    category: 'utility',
    source: 'git',
    githubRepo: 'OWASP/owasp-mstg',
    defaultChecked: false
  },
  {
    id: 'owasp-top10',
    name: 'OWASP Top 10',
    description: 'Documentation et retours d’expérience sur le Top 10',
    category: 'utility',
    source: 'git',
    githubRepo: 'OWASP/www-project-top-ten',
    defaultChecked: false
  },
  {
    id: 'owasp-nettacker',
    name: 'OWASP Nettacker',
    description: 'Recon automatisée multi-protocole avec scoring de surface',
    category: 'utility',
    source: 'git',
    githubRepo: 'OWASP/Nettacker',
    defaultChecked: false
  },
  {
    id: 'nuclei-templates',
    name: 'nuclei-templates',
    description: 'Templates communautaires pour nuclei (sont415 uniquement)',
    category: 'utility',
    source: 'git',
    githubRepo: 'projectdiscovery/nuclei-templates',
    defaultChecked: false
  },
  {
    id: 'seclists',
    name: 'SecLists',
    description: 'Wordlists (chemins, sous-domaines, paramètres…) utilisées par ffuf et les scans “Élevé”. Clone uniquement, aucune exécution.',
    category: 'utility',
    source: 'git',
    githubRepo: 'danielmiessler/SecLists',
    defaultChecked: false
  },
  {
    id: 'payloads-all-things',
    name: 'PayloadsAllTheThings',
    description: 'Payloads, wordlists et bypass pour tests d’intrusion',
    category: 'utility',
    source: 'git',
    githubRepo: 'swisskyrepo/PayloadsAllTheThings',
    defaultChecked: false
  },
  {
    id: 'assetnote-wordlists',
    name: 'Assetnote Wordlists',
    description: 'Wordlists curationnées orientées sous-domaines et API',
    category: 'utility',
    source: 'git',
    githubRepo: 'assetnote/wordlists',
    defaultChecked: false
  },
  {
    id: 'fuzzdb',
    name: 'fuzzdb',
    description: 'Base de payloads et wordlists pour le fuzzing web',
    category: 'utility',
    source: 'git',
    githubRepo: 'fuzzdb-project/fuzzdb',
    defaultChecked: false
  },
  {
    id: 'fuzz-txt',
    name: 'fuzz.txt',
    description: 'Liste de fichiers et extensions dangereux à tester',
    category: 'utility',
    source: 'git',
    githubRepo: 'Bo0oM/fuzz.txt',
    defaultChecked: false
  },
  {
    id: 'syft',
    name: 'Syft',
    description: 'Génère un SBOM depuis les images et répertoires',
    category: 'utility',
    source: 'winget',
    wingetId: 'Anchore.Syft',
    detectCmd: 'syft',
    defaultChecked: false
  },
  {
    id: 'grype',
    name: 'Grype',
    description: 'Scan de vulnérabilités à partir d’un SBOM ou d’une image',
    category: 'utility',
    source: 'winget',
    wingetId: 'Anchore.Grype',
    detectCmd: 'grype',
    defaultChecked: false
  },
  {
    id: 'trivy',
    name: 'Trivy',
    description: 'Scanner de vulnérabilités (images, FS, dépendances, IaC)',
    category: 'utility',
    source: 'winget',
    wingetId: 'AquaSecurity.Trivy',
    detectCmd: 'trivy',
    defaultChecked: false
  },
  {
    id: 'whois',
    name: 'Whois',
    description: 'Recherche WHOIS depuis le terminal (Sysinternals)',
    category: 'utility',
    source: 'winget',
    wingetId: 'Microsoft.Sysinternals.Whois',
    aptPackage: 'whois',
    defaultChecked: false
  },
  {
    id: 'burpsuite',
    name: 'Burp Suite Community',
    description: 'Proxy d’interception et scanner web (reconnaissance, modification de requêtes)',
    category: 'recon',
    source: 'winget',
    wingetId: 'PortSwigger.BurpSuite.Community',
    guiOnly: true,
    defaultChecked: true
  },
  {
    id: 'zap',
    name: 'OWASP ZAP',
    description: 'Proxy d’interception et scanner DAST',
    category: 'recon',
    source: 'winget',
    wingetId: 'ZAP.ZAP',
    detectCmd: 'zap.sh',
    defaultChecked: false
  },
  {
    id: 'fiddler',
    name: 'Fiddler Classic',
    description: 'Proxy de capture HTTP/HTTPS avec scriptabilité',
    category: 'recon',
    source: 'winget',
    wingetId: 'Telerik.Fiddler.Classic',
    windowsOnly: true,
    defaultChecked: false
  },
  {
    id: 'postman',
    name: 'Postman',
    description: 'Client et collection de requêtes API',
    category: 'recon',
    source: 'winget',
    wingetId: 'Postman.Postman',
    guiOnly: true,
    defaultChecked: false
  },
  {
    id: 'insomnia',
    name: 'Insomnia',
    description: 'Client REST/GraphQL, alternative légère à Postman',
    category: 'recon',
    source: 'winget',
    wingetId: 'Insomnia.Insomnia',
    guiOnly: true,
    defaultChecked: false
  },
  {
    id: 'bruno',
    name: 'Bruno',
    description: 'Client API, collections stockées en texte dans le dépôt',
    category: 'recon',
    source: 'winget',
    wingetId: 'Bruno.Bruno',
    guiOnly: true,
    defaultChecked: false
  },
  {
    id: 'powershell',
    name: 'PowerShell 7',
    description: 'PowerShell moderne (cross-platform)',
    category: 'utility',
    source: 'winget',
    wingetId: 'Microsoft.PowerShell',
    detectCmd: 'pwsh',
    defaultChecked: false
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Modèles de langage locaux (aide à l’analyse sans envoi de données)',
    category: 'ai',
    source: 'winget',
    wingetId: 'Ollama.Ollama',
    detectCmd: 'ollama',
    defaultChecked: false
  },
  {
    id: 'ai-hunter',
    name: 'BugHunter AI (Claude Code)',
    description:
      'Framework de chasse autonome : agents Claude Code, orchestration par machine à états, Burp MCP. Clone dans `userData/tools`, à activer ensuite dans Claude Code (voir le guide).',
    category: 'ai',
    source: 'git',
    githubRepo: 'h4ckologic/bughunter-ai',
    defaultChecked: false
  },
  {
    id: 'waymore',
    name: 'Waymore',
    description: "Harvesting d'URLs depuis Wayback Machine et sources passives",
    category: 'recon',
    source: 'pip',
    pipPackage: 'waymore',
    defaultChecked: false
  },
  {
    id: 'uro',
    name: 'Uro',
    description: "Déduplication de listes d'URLs avant fuzzing",
    category: 'fuzz',
    source: 'pip',
    pipPackage: 'uro',
    defaultChecked: false
  },
  {
    id: 'h8mail',
    name: 'h8mail',
    description: "Recherche d'emails et de fuites associées",
    category: 'recon',
    source: 'pip',
    pipPackage: 'h8mail',
    defaultChecked: false
  },
  {
    id: 'git-dumper',
    name: 'Git Dumper',
    description: "Récupération d'un dépôt .git exposé publiquement",
    category: 'recon',
    source: 'pip',
    pipPackage: 'git-dumper',
    defaultChecked: false
  }
]

export function getTool(id: string): ToolDefinition | undefined {
  return TOOL_CATALOG.find((t) => t.id === id)
}

export type ToolInstallationResult = { ok: true; installed: boolean } | { ok: false; error: string }
