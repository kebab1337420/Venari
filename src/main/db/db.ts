import { DatabaseSync } from 'node:sqlite'
import { migrations, type Migration } from './migrations'

export type Db = DatabaseSync

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  // SQLite leve SQLITE_BUSY immediatement par defaut. En WAL avec un scan qui
  // ecrit en continu, on prefere attendre le verrou plutot que de perdre une
  // requete de l'interface.
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA synchronous = NORMAL;')
  migrate(db)
  return db
}

// La liste est injectable pour pouvoir tester le runner (montée par etapes,
// annulation en cas d'echec) sans dependre de la liste reelle du produit.
export function migrate(db: Db, list: Migration[] = migrations): void {
  const row = db.prepare('SELECT user_version FROM pragma_user_version').get() as
    | { user_version: number }
    | undefined
  const current = row?.user_version ?? 0
  for (const m of list) {
    if (m.version <= current) continue
    begin(db)
    try {
      m.up(db)
      db.exec(`PRAGMA user_version = ${m.version};`)
      db.exec('COMMIT;')
    } catch (err) {
      db.exec('ROLLBACK;')
      throw err
    }
  }
}

export function begin(db: Db): void {
  db.exec('BEGIN;')
}