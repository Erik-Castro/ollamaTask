import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { EmbeddingClient } from "./client.ts";
import { openDatabase, type DbHandle } from "./sqlite.ts";
import type {
  DocumentKind,
  DocumentRecord,
  EmbeddingStoreOptions,
  SearchHit,
} from "./types.ts";

export class EmbeddingStore {
  private handle: DbHandle | null = null;
  private client: EmbeddingClient;
  private dimensions: number;
  private dbPath: string;

  constructor(options?: EmbeddingStoreOptions) {
    this.dbPath = options?.dbPath ?? "./data/memory.db";
    this.dimensions = options?.dimensions ?? 768;
    this.client = new EmbeddingClient(options?.embeddingModel, {
      useTaskPrefixes: options?.useTaskPrefixes,
    });
  }

  async open(): Promise<void> {
    this.handle = openDatabase(this.dbPath);
  }

  close(): void {
    this.handle?.close();
    this.handle = null;
  }

  private get db(): DatabaseSync {
    if (!this.handle) throw new Error("EmbeddingStore not opened. Call open() first.");
    return this.handle.db;
  }

  async add(params: {
    text: string;
    kind?: DocumentKind;
    metadata?: Record<string, unknown>;
    id?: string;
  }): Promise<string> {
    const id = params.id ?? randomUUID();
    const kind = params.kind ?? "run";
    const meta = JSON.stringify(params.metadata ?? {});
    const now = Date.now();
    const embedding = await this.client.embedDocument(params.text);
    const blob = toVecBlob(embedding);

    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        `INSERT INTO documents (id, text, kind, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, params.text, kind, meta, now, now);

      this.db.prepare(
        `INSERT INTO vec_documents (document_id, embedding)
         VALUES (?, ?)`,
      ).run(id, blob);

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return id;
  }

  async addBatch(
    items: Array<{
      text: string;
      kind?: DocumentKind;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    const now = Date.now();

    const embeddings = await this.client.embedBatch(
      items.map((i) => i.text),
      "document",
    );

    this.db.exec("BEGIN");
    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const id = randomUUID();
        const kind = item.kind ?? "run";
        const meta = JSON.stringify(item.metadata ?? {});
        const blob = toVecBlob(embeddings[i]);

        this.db.prepare(
          `INSERT INTO documents (id, text, kind, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, item.text, kind, meta, now, now);

        this.db.prepare(
          `INSERT INTO vec_documents (document_id, embedding)
           VALUES (?, ?)`,
        ).run(id, blob);

        ids.push(id);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return ids;
  }

  async search(params: {
    query: string;
    topK?: number;
    minScore?: number;
    kind?: DocumentKind | DocumentKind[];
  }): Promise<SearchHit[]> {
    const topK = params.topK ?? 5;
    const minScore = params.minScore ?? 0.0;
    const queryEmbedding = await this.client.embedQuery(params.query);

    let rows: Array<{
      id: string;
      text: string;
      kind: string;
      metadata: string;
      created_at: number;
      updated_at: number;
      embedding: Uint8Array;
    }>;

    if (params.kind) {
      const kinds = Array.isArray(params.kind) ? params.kind : [params.kind];
      const placeholders = kinds.map(() => "?").join(",");
      rows = this.db.prepare(
        `SELECT d.*, v.embedding
         FROM documents d
         JOIN vec_documents v ON d.id = v.document_id
         WHERE d.kind IN (${placeholders})`,
      ).all(...kinds) as typeof rows;
    } else {
      rows = this.db.prepare(
        `SELECT d.*, v.embedding
         FROM documents d
         JOIN vec_documents v ON d.id = v.document_id`,
      ).all() as typeof rows;
    }

    const scored: SearchHit[] = rows.map((row) => {
      const storedEmbedding = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const distance = l2Distance(queryEmbedding, storedEmbedding);
      const score = 1 / (1 + distance);

      return {
        id: row.id,
        text: row.text,
        kind: row.kind as DocumentKind,
        metadata: JSON.parse(row.metadata),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        score,
        distance,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored
      .filter((h) => h.score >= minScore)
      .slice(0, topK);
  }

  async getById(id: string): Promise<DocumentRecord | null> {
    const row = this.db.prepare(
      `SELECT * FROM documents WHERE id = ?`,
    ).get(id) as {
      id: string;
      text: string;
      kind: string;
      metadata: string;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      text: row.text,
      kind: row.kind as DocumentKind,
      metadata: JSON.parse(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async delete(id: string): Promise<boolean> {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM vec_documents WHERE document_id = ?`).run(
        id,
      );
      const result = this.db.prepare(
        `DELETE FROM documents WHERE id = ?`,
      ).run(id);
      this.db.exec("COMMIT");
      return result.changes > 0;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async pruneCache(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;

    this.db.exec("BEGIN");
    try {
      const ids = this.db.prepare(
        `SELECT id FROM documents WHERE kind = 'cache' AND created_at < ?`,
      ).all(cutoff) as Array<{ id: string }>;

      for (const { id } of ids) {
        this.db.prepare(`DELETE FROM vec_documents WHERE document_id = ?`).run(
          id,
        );
        this.db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
      }

      this.db.exec("COMMIT");
      return ids.length;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async stats(): Promise<{
    total: number;
    byKind: Record<string, number>;
  }> {
    const total = (
      this.db.prepare(`SELECT COUNT(*) as c FROM documents`).get() as {
        c: number;
      }
    ).c;

    const rows = this.db.prepare(
      `SELECT kind, COUNT(*) as c FROM documents GROUP BY kind`,
    ).all() as Array<{ kind: string; c: number }>;

    const byKind: Record<string, number> = {};
    for (const row of rows) {
      byKind[row.kind] = row.c;
    }

    return { total, byKind };
  }
}

function toVecBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function l2Distance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}
