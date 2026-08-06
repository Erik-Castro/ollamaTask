export type DocumentKind = "run" | "route_example" | "chunk" | "cache";

export interface DocumentRecord {
  id: string;
  text: string;
  kind: DocumentKind;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SearchHit extends DocumentRecord {
  /** 0-1, higher = more similar (converted from L2 distance) */
  score: number;
  distance: number;
}

export interface EmbeddingStoreOptions {
  /** default: "./data/memory.db" */
  dbPath?: string;
  /** default: "nomic-embed-text" */
  embeddingModel?: string;
  /** default: 768 */
  dimensions?: number;
  /** Use nomic task prefixes (search_query: / search_document:). default: true */
  useTaskPrefixes?: boolean;
}
