import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

export interface DbHandle {
  db: DatabaseSync;
  close(): void;
}

export function openDatabase(dbPath: string): DbHandle {
  if (dbPath !== ":memory:") {
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir) mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  migrate(db);

  return {
    db,
    close() {
      db.close();
    },
  };
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id          TEXT PRIMARY KEY,
      text        TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'run',
      metadata    TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_documents_kind
      ON documents(kind);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_documents_created
      ON documents(created_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_documents (
      document_id TEXT PRIMARY KEY,
      embedding   BLOB NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
  `);
}
