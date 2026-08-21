import Database from "better-sqlite3-multiple-ciphers";

export interface DatabaseOptions {
  path?: string;
  keyPath?: string;
  vectorExtensionPath?: string;
  debug?: (message?: unknown, ...args: unknown[]) => void;
}

const KEY_SIZE = 16;

export class CipherDatabase extends Database {
  [Symbol.dispose](): void {
    if (this.open) this.close();
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    .toUpperCase();
}

async function loadOrCreateKey(keyPath: string): Promise<string> {
  try {
    const bytes = await Deno.readFile(keyPath);
    if (bytes.length !== KEY_SIZE) {
      throw new Error(
        `O arquivo ${keyPath} deve conter exatamente ${KEY_SIZE} bytes.`,
      );
    }
    return toHex(bytes);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const bytes = crypto.getRandomValues(new Uint8Array(KEY_SIZE));
  try {
    await Deno.writeFile(keyPath, bytes, { createNew: true, mode: 0o600 });
    return toHex(bytes);
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    const existing = await Deno.readFile(keyPath);
    if (existing.length !== KEY_SIZE) {
      throw new Error(
        `O arquivo ${keyPath} deve conter exatamente ${KEY_SIZE} bytes.`,
      );
    }
    return toHex(existing);
  }
}

function migrate(db: CipherDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
  `);
}

export async function openDatabase(
  options: DatabaseOptions = {},
): Promise<CipherDatabase> {
  const path = options.path ?? "rag.db";
  const keyPath = options.keyPath ?? ".key";
  const vectorExtensionPath = options.vectorExtensionPath ?? "./bin/vector.so";
  const key = await loadOrCreateKey(keyPath);
  const db = new CipherDatabase(
    path,
    options.debug ? { verbose: options.debug } : undefined,
  );
  db.pragma(`key = 'x${key}'`);
  db.pragma("journal_mode = WAL");
  db.loadExtension(vectorExtensionPath);
  migrate(db);
  return db;
}
