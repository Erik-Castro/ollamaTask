import { type CipherDatabase, openDatabase } from "./database.ts";
import { type ChatMessage, type LLMProvider } from "./providers/types.ts";
import { OllamaProvider } from "./providers/ollama.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { type ChunkerOptions, chunkText } from "./chunker.ts";
import { type EmbeddedChunk, type SearchHit, VectorStore } from "./store.ts";

export interface RagOptions extends ChunkerOptions {
  dbPath?: string;
  keyPath?: string;
  vectorExtensionPath?: string;
  provider?: "ollama" | "openai";
  ollamaHost?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  embedModel?: string;
  genModel?: string;
  topK?: number;
  systemPrompt?: string;
}

export interface QueryResult {
  answer: string;
  sources: SearchHit[];
  model: string;
}

export interface QueryStreamResult {
  sources: SearchHit[];
  stream: AsyncGenerator<string, void, unknown>;
  model: string;
}

export const DEFAULT_EMBED_MODEL = "nomic-embed-text";
export const DEFAULT_GEN_MODEL = "lfm2.5-thinking";

const DEFAULT_SYSTEM_PROMPT =
  `Você é um assistente que responde perguntas usando EXCLUSIVAMENTE os trechos de contexto fornecidos.
Regras:
- Responda no mesmo idioma da pergunta.
- Cite as fontes usadas no formato [1], [2], etc.
- Se a resposta não estiver no contexto, diga claramente que não sabe.`;

function resolvePath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function buildContext(hits: SearchHit[]): string {
  return hits
    .map((hit, i) =>
      `[${i + 1}] (fonte: ${
        hit.title ?? hit.source ?? "desconhecida"
      })\n${hit.content}`
    )
    .join("\n\n---\n\n");
}

function buildMessages(
  hits: SearchHit[],
  question: string,
  systemPrompt: string,
): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Contexto:\n${buildContext(hits)}\n\nPergunta: ${question}`,
    },
  ];
}

export class RAG {
  readonly #provider: LLMProvider;
  readonly #store: VectorStore;
  readonly #db: CipherDatabase;
  readonly #embedModel: string;
  readonly #genModel: string;
  readonly #topK: number;
  readonly #systemPrompt: string;
  readonly #maxChars: number;
  readonly #overlapChars: number;

  private constructor(
    db: CipherDatabase,
    provider: LLMProvider,
    options: RagOptions,
  ) {
    this.#db = db;
    this.#provider = provider;
    this.#store = new VectorStore(db);
    this.#embedModel = options.embedModel ?? DEFAULT_EMBED_MODEL;
    this.#genModel = options.genModel ?? DEFAULT_GEN_MODEL;
    this.#topK = options.topK ?? 5;
    this.#systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#maxChars = options.maxChars ?? 1200;
    this.#overlapChars = options.overlapChars ?? 200;
  }

  static async create(options: RagOptions = {}): Promise<RAG> {
    const db = await openDatabase({
      path: options.dbPath ?? "rag.db",
      keyPath: options.keyPath ?? ".key",
      vectorExtensionPath: options.vectorExtensionPath ?? "./bin/vector.so",
    });
    const provider = options.provider === "openai"
      ? new OpenAIProvider({
        baseURL: options.openaiBaseUrl,
        apiKey: options.openaiApiKey,
      })
      : new OllamaProvider({ host: options.ollamaHost });
    return new RAG(db, provider, options);
  }

  async ensureModel(onProgress?: (status: string) => void): Promise<void> {
    if (!this.#provider.pull) {
      throw new Error(
        "Gerenciamento de modelos não suportado neste provider. " +
          "Use 'ollama pull <model>' manualmente ou troque para o provider 'ollama'.",
      );
    }
    for (const model of [this.#embedModel, this.#genModel]) {
      if (!(await this.#provider.hasModel(model))) {
        onProgress?.(`baixando ${model}...`);
        await this.#provider.pull(model, onProgress);
      }
    }
  }

  async #embed(texts: string[]): Promise<number[][]> {
    const embeddings = await this.#provider.embed(this.#embedModel, texts);
    if (embeddings.length !== texts.length) {
      throw new Error(
        `Embedding retornou ${embeddings.length} vetores para ${texts.length} textos.`,
      );
    }
    for (const emb of embeddings) {
      if (!Array.isArray(emb) || emb.length === 0) {
        throw new Error("Embedding retornou vetor vazio ou inválido.");
      }
    }
    return embeddings;
  }

  async addText(
    text: string,
    meta: { title?: string; source?: string } = {},
  ): Promise<number> {
    const chunks = chunkText(text, {
      maxChars: this.#maxChars,
      overlapChars: this.#overlapChars,
    });
    if (chunks.length === 0) throw new Error("Texto vazio: nada para indexar.");
    const embeddings = await this.#embed(chunks.map((chunk) => chunk.content));
    const docId = this.#store.addDocument(
      meta.source ?? null,
      meta.title ?? null,
    );
    const embedded: EmbeddedChunk[] = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i],
    }));
    this.#store.addChunks(docId, embedded);
    return docId;
  }

  async addFile(filePath: string): Promise<number> {
    const content = await Deno.readTextFile(filePath);
    const title = resolvePath(filePath);
    return this.addText(content, { source: filePath, title });
  }

  async search(query: string, opts: { k?: number } = {}): Promise<SearchHit[]> {
    const [embedding] = await this.#embed([query]);
    this.#store.initialize(embedding.length);
    return this.#store.search(embedding, opts.k ?? this.#topK);
  }

  async query(
    question: string,
    opts: { k?: number } = {},
  ): Promise<QueryResult> {
    const hits = await this.search(question, opts);
    if (hits.length === 0) {
      return {
        answer: "Não encontrei trechos relevantes para responder à pergunta.",
        sources: [],
        model: this.#genModel,
      };
    }
    const messages = buildMessages(hits, question, this.#systemPrompt);
    const result = await this.#provider.chat(this.#genModel, messages);
    return {
      answer: result.content.trim(),
      sources: hits,
      model: result.model,
    };
  }

  async queryStream(
    question: string,
    opts: { k?: number } = {},
  ): Promise<QueryStreamResult> {
    const hits = await this.search(question, opts);
    if (hits.length === 0) {
      return {
        sources: [],
        stream: (async function* () {
          yield "Não encontrei trechos relevantes para responder à pergunta.";
        })(),
        model: this.#genModel,
      };
    }
    const messages = buildMessages(hits, question, this.#systemPrompt);
    const stream = this.#provider.chatStream(this.#genModel, messages);
    return { sources: hits, stream, model: this.#genModel };
  }

  get embedModel(): string {
    return this.#embedModel;
  }
  get genModel(): string {
    return this.#genModel;
  }
  get topK(): number {
    return this.#topK;
  }
  documentCount(): number {
    return this.#store.documentCount();
  }
  chunkCount(): number {
    return this.#store.chunkCount();
  }
  [Symbol.dispose](): void {
    this.#db.close();
  }
}
