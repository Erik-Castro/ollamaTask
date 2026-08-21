import type { Chunk } from "./chunker.ts";
import type { CipherDatabase } from "./database.ts";

export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

export interface SearchHit {
  chunkId: number;
  documentId: number;
  index: number;
  content: string;
  source: string | null;
  title: string | null;
  distance: number;
  score: number;
}

interface SearchRow {
  chunk_id: number;
  document_id: number;
  idx: number;
  content: string;
  source: string | null;
  title: string | null;
  distance: number;
}

interface InsertResult {
  lastInsertRowid: number | bigint;
}

export class VectorStore {
  readonly #db: CipherDatabase;
  #dimension: number | null = null;

  constructor(db: CipherDatabase) {
    this.#db = db;
  }

  initialize(dimension: number): void {
    if (this.#dimension === dimension) return;
    this.#db
      .prepare(
        `SELECT vector_init('chunks', 'embedding', 'dimension=${dimension},type=FLOAT32,distance=COSINE')`,
      )
      .get();
    this.#dimension = dimension;
  }

  addDocument(source: string | null, title: string | null): number {
    const result = this.#db
      .prepare("INSERT INTO documents (source, title) VALUES (?, ?)")
      .run(source, title) as InsertResult;
    return Number(result.lastInsertRowid);
  }

  addChunks(documentId: number, chunks: EmbeddedChunk[]): void {
    const insert = this.#db.prepare(
      "INSERT INTO chunks (document_id, idx, content, embedding) VALUES (?, ?, ?, vector_as_f32(?))",
    );
    const insertAll = this.#db.transaction((items: EmbeddedChunk[]) => {
      for (const chunk of items) {
        insert.run(
          documentId,
          chunk.index,
          chunk.content,
          JSON.stringify(chunk.embedding),
        );
      }
    });
    insertAll(chunks);
  }

  search(embedding: number[], k: number): SearchHit[] {
    this.initialize(embedding.length);
    const rows = this.#db
      .prepare(
        `
        SELECT c.id AS chunk_id,
               c.document_id,
               c.idx,
               c.content,
               d.source,
               d.title,
               v.distance
          FROM chunks AS c
          JOIN documents AS d ON d.id = c.document_id
          JOIN vector_full_scan('chunks', 'embedding', vector_as_f32(?), ?) AS v ON v.rowid = c.id
         ORDER BY v.distance
        `,
      )
      .all(JSON.stringify(embedding), BigInt(Math.floor(k))) as SearchRow[];

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      index: row.idx,
      content: row.content,
      source: row.source,
      title: row.title,
      distance: row.distance,
      score: 1 - row.distance,
    }));
  }

  documentCount(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM documents").get() as {
      n: number;
    }).n;
  }

  chunkCount(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {
      n: number;
    }).n;
  }
}
