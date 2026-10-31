import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  version: number
  up: (db: DatabaseSync) => void
}

export const migrations: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE programs (
          id                TEXT PRIMARY KEY,
          handle            TEXT NOT NULL,
          name              TEXT NOT NULL,
          type              TEXT,
          status            TEXT,
          confidentiality   TEXT,
          min_bounty_value    REAL,
          min_bounty_currency TEXT,
          max_bounty_value    REAL,
          max_bounty_currency TEXT,
          industry          TEXT,
          web_link          TEXT,
          following         INTEGER NOT NULL DEFAULT 0,
          raw_json          TEXT,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX idx_programs_name ON programs(name);
        CREATE INDEX idx_programs_status ON programs(status);

        CREATE TABLE favorites (
          program_id TEXT PRIMARY KEY REFERENCES programs(id) ON DELETE CASCADE,
          favorite   INTEGER NOT NULL DEFAULT 0,
          note       TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE groups (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL UNIQUE,
          color      TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE group_members (
          group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          program_id TEXT    NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
          PRIMARY KEY (group_id, program_id)
        );
        CREATE INDEX idx_group_members_program ON group_members(program_id);

        CREATE TABLE tags (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE program_tags (
          program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
          tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (program_id, tag_id)
        );
        CREATE INDEX idx_program_tags_tag ON program_tags(tag_id);
      `)
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE program_details (
          program_id TEXT PRIMARY KEY REFERENCES programs(id) ON DELETE CASCADE,
          scope_json TEXT,
          roe_json TEXT,
          fetched_at INTEGER NOT NULL
        );

        CREATE TABLE credentials (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
          label      TEXT NOT NULL,
          username   TEXT NOT NULL DEFAULT '',
          secret_enc TEXT NOT NULL DEFAULT '',
          note       TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_credentials_program ON credentials(program_id);
      `)
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE scans (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          program_id  TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
          depth       TEXT NOT NULL,
          status      TEXT NOT NULL,
          rate_limit  INTEGER NOT NULL DEFAULT 1,
          roe_confirm INTEGER NOT NULL DEFAULT 0,
          started_at  INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE INDEX idx_scans_program ON scans(program_id);

        CREATE TABLE scan_events (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
          seq     INTEGER NOT NULL,
          ts      INTEGER NOT NULL,
          level   TEXT NOT NULL,
          message TEXT NOT NULL
        );
        CREATE INDEX idx_scan_events_scan ON scan_events(scan_id, seq);
      `)
    },
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE mcp_requests (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          ts          INTEGER NOT NULL,
          token_label TEXT NOT NULL DEFAULT '',
          tool        TEXT NOT NULL,
          args_json   TEXT NOT NULL DEFAULT '{}',
          status      TEXT NOT NULL,
          ms          INTEGER NOT NULL
        );
        CREATE INDEX idx_mcp_requests_ts ON mcp_requests(ts);
      `)
    },
  },
  {
    version: 5,
    up(db) {
      db.exec(`ALTER TABLE mcp_requests ADD COLUMN remote_ip TEXT NOT NULL DEFAULT '';`)
    },
  },
  {
    version: 6,
    up(db) {
      db.exec(`
        CREATE TABLE remote_sessions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_token  TEXT NOT NULL,
          agent_label  TEXT NOT NULL DEFAULT '',
          remote_ip    TEXT NOT NULL DEFAULT '',
          status       TEXT NOT NULL,
          width        INTEGER,
          height       INTEGER,
          requested_at INTEGER NOT NULL,
          decided_at   INTEGER,
          ended_at     INTEGER
        );
        CREATE INDEX idx_remote_sessions_ts ON remote_sessions(requested_at);
      `)
    },
  },
  {
    version: 7,
    up(db) {
      // Tri et recherche de la liste de programmes : le tri par defaut est
      // "name COLLATE NOCASE", la recherche porte sur name/handle/industry.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_programs_name_nocase ON programs(name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_programs_handle_nocase ON programs(handle COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_programs_updated_at ON programs(updated_at DESC);
      `)
    },
  },
  {
    version: 8,
    up(db) {
      // Suivi de findings : la piece manquante entre les scans et les rapports.
      // `report_path` pointe un fichier de userData/reports (relatif) ; la
      // suppression du programme emporte ses findings, comme le reste.
      db.exec(`
        CREATE TABLE findings (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          program_id  TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
          asset       TEXT NOT NULL DEFAULT '',
          title       TEXT NOT NULL,
          severity    TEXT NOT NULL DEFAULT 'info',
          cvss        REAL,
          status      TEXT NOT NULL DEFAULT 'open',
          description TEXT NOT NULL DEFAULT '',
          poc         TEXT NOT NULL DEFAULT '',
          report_path TEXT,
          scan_id     INTEGER,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX idx_findings_program ON findings(program_id);
        CREATE INDEX idx_findings_status ON findings(status);
        CREATE INDEX idx_findings_updated ON findings(updated_at DESC);
      `)
    },
  },
  {
    version: 9,
    up(db) {
      // Empreinte du scope vue au dernier rafraichissement. La prochaine
      // ouverture de la fiche compare l'empreinte stockee au scope courant et
      // signale les cibles ajoutees ou retirees entre-temps.
      db.exec(`
        CREATE TABLE program_scope_state (
          program_id   TEXT PRIMARY KEY REFERENCES programs(id) ON DELETE CASCADE,
          entries_json TEXT NOT NULL,
          checked_at   INTEGER NOT NULL
        );
      `)
    },
  },
  {
    version: 10,
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
        CREATE INDEX IF NOT EXISTS idx_findings_scan ON findings(scan_id);
      `)
    },
  },
]