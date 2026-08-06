# Spec: Semantic Memory Layer — SQLite + sqlite-vec

**Projeto:** ollamaTask\
**Status:** Draft\
**Escopo:** Camada de embeddings + memória semântica persistente para routing,
cache e contexto entre pipelines.

---

## 1. Objetivo

Adicionar ao `ollamaTask` uma camada de **memória semântica local** que permita:

1. **Roteamento** de prompts para pipelines adequados
2. **Cache semântico** (evitar reprocessar inputs muito similares)
3. **Recuperação de contexto** (few-shot / histórico de execuções)
4. **Persistência** em arquivo SQLite com busca vetorial via `sqlite-vec`

Tudo offline, sem serviços externos além do Ollama (modelo de embedding).

---

## 2. Stack

| Componente        | Escolha                                | Notas                              |
| ----------------- | -------------------------------------- | ---------------------------------- |
| Runtime           | Deno 2.x                               | Já usado no projeto                |
| SQLite driver     | `jsr:@db/sqlite`                       | Suporte a loadable extensions      |
| Extensão vetorial | `npm:sqlite-vec`                       | `vec0` virtual tables              |
| Embeddings        | Ollama `nomic-embed-text`              | 768 dims, leve, bom para retrieval |
| Persistência      | Arquivo `.db` (ex: `./data/memory.db`) | Path configurável                  |

### Dependências

```bash
deno add npm:sqlite-vec
deno add jsr:@db/sqlite
# Ollama já presente via npm:ollama
ollama pull nomic-embed-text
```

---

## 3. Arquitetura

```
┌──────────────────────────────────────────────────────────┐
│                     Application                          │
│  SemanticRouter  ·  cachedRun  ·  ollamaPipeline         │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│                   EmbeddingStore                         │
│  add() · search() · getById() · delete() · stats()       │
└──────────────────────────┬───────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                                 ▼
┌─────────────────────┐           ┌─────────────────────┐
│  EmbeddingClient    │           │  SqliteVecBackend   │
│  (Ollama embed API) │           │  vec0 + metadata    │
└─────────────────────┘           └─────────────────────┘
```

---

## 4. Schema do banco

### 4.1 Tabela de metadados (SQLite normal)

```sql
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,          -- UUID
  text        TEXT NOT NULL,             -- texto original (ou resumo)
  kind        TEXT NOT NULL DEFAULT 'run', -- 'run' | 'route_example' | 'chunk' | 'cache'
  metadata    TEXT NOT NULL DEFAULT '{}', -- JSON
  created_at  INTEGER NOT NULL,          -- unix ms
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);
```

### 4.2 Tabela vetorial (sqlite-vec)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS vec_documents USING vec0(
  document_id TEXT PRIMARY KEY,
  embedding float[768]                    -- dimensão fixa do nomic-embed-text
);
```

> **Importante:** `sqlite-vec` usa distância L2 por padrão no `MATCH`. Para
> similaridade coseno, normalizar os vetores antes de inserir/buscar **ou**
> converter distância em score na aplicação.

### 4.3 Relação

- `documents.id` ↔ `vec_documents.document_id`
- Insert/delete devem ser atômicos (transaction)

---

## 5. API TypeScript

### 5.1 Tipos

```ts
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
  /** 0–1, maior = mais similar (após conversão da distância) */
  score: number;
  distance: number;
}

export interface EmbeddingStoreOptions {
  dbPath?: string; // default: "./data/memory.db"
  embeddingModel?: string; // default: "nomic-embed-text"
  dimensions?: number; // default: 768
  /** Prefixos do nomic (recomendado) */
  useTaskPrefixes?: boolean; // default: true
}
```

### 5.2 `EmbeddingClient`

```ts
class EmbeddingClient {
  constructor(model?: string, options?: { useTaskPrefixes?: boolean });

  /** Embedding de query (prefixo search_query: se habilitado) */
  embedQuery(text: string): Promise<Float32Array>;

  /** Embedding de documento (prefixo search_document:) */
  embedDocument(text: string): Promise<Float32Array>;

  embedBatch(
    texts: string[],
    as: "query" | "document",
  ): Promise<Float32Array[]>;
}
```

### 5.3 `EmbeddingStore`

```ts
class EmbeddingStore {
  constructor(options?: EmbeddingStoreOptions);

  /** Abre DB, carrega sqlite-vec, cria schema se necessário */
  open(): Promise<void>;
  close(): void;

  add(params: {
    text: string;
    kind?: DocumentKind;
    metadata?: Record<string, unknown>;
    id?: string; // opcional; senão UUID
  }): Promise<string>; // retorna id

  addBatch(
    items: Array<{
      text: string;
      kind?: DocumentKind;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<string[]>;

  search(params: {
    query: string;
    topK?: number; // default 5
    minScore?: number; // default 0.0
    kind?: DocumentKind | DocumentKind[];
  }): Promise<SearchHit[]>;

  getById(id: string): Promise<DocumentRecord | null>;

  delete(id: string): Promise<boolean>;

  /** Remove entradas de cache mais antigas que `olderThanMs` */
  pruneCache(olderThanMs: number): Promise<number>;

  stats(): Promise<{
    total: number;
    byKind: Record<string, number>;
  }>;
}
```

### 5.4 Integração com router (opcional nesta fase)

```ts
class SemanticRouter {
  constructor(store: EmbeddingStore);

  register(route: {
    name: string;
    examples: string[]; // persistidos como kind: "route_example"
    run: (input: string, context?: string) => Promise<ExecutionResult>;
  }): Promise<void>;

  route(input: string): Promise<{
    route: string;
    score: number;
    result: ExecutionResult;
  }>;
}
```

---

## 6. Comportamentos obrigatórios

### 6.1 Serialização de vetores

sqlite-vec (Deno/`@db/sqlite`) espera **BLOB** como `Uint8Array` de
`Float32Array`:

```ts
function toVecBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}
```

### 6.2 Score a partir da distância

`vec0` retorna `distance` (L2). Converter para score ≈ similaridade:

```ts
// Heurística simples (ajustável)
score = 1 / (1 + distance);
```

Documentar que o score **não** é coseno puro a menos que os vetores estejam
L2-normalizados na inserção.

### 6.3 Transações

`add` / `delete` devem usar transaction:

```sql
BEGIN;
  INSERT INTO documents (...);
  INSERT INTO vec_documents(document_id, embedding) VALUES (?, ?);
COMMIT;
```

### 6.4 Prefixos do Nomic

Quando `useTaskPrefixes: true`:

| Operação              | Prefixo            |
| --------------------- | ------------------ |
| `embedQuery` / search | `search_query:`    |
| `embedDocument` / add | `search_document:` |

### 6.5 Path do DB

- Default: `./data/memory.db`
- Criar diretório se não existir
- Aceitar `:memory:` para testes

---

## 7. Fluxos principais

### 7.1 Cache semântico

```
input
  → embedQuery
  → search(kind="cache", topK=1, minScore=0.93)
  → hit? retorna metadata.fullOutput
  → miss? executa pipeline → add(kind="cache", metadata={ fullOutput })
```

### 7.2 Memória de runs

Após cada `execute()` bem-sucedido:

```
add({
  text: userInput,
  kind: "run",
  metadata: {
    route?: string,
    model?: string,
    outputPreview: content.slice(0, 300),
    inputTokens, outputTokens,
  }
})
```

Na próxima execução similar, `search(kind="run")` injeta os top-k como contexto.

### 7.3 Registro de rotas

Ao registrar uma rota no `SemanticRouter`, cada `example` vira:

```
add({ text: example, kind: "route_example", metadata: { route: name } })
```

O router busca `kind="route_example"` e agrupa por `metadata.route` para
escolher a melhor rota.

---

## 8. Estrutura de arquivos sugerida

```
ollamaTask/
├── ollamaTask.ts              # existente
├── embeddings/
│   ├── client.ts              # EmbeddingClient
│   ├── store.ts               # EmbeddingStore
│   ├── sqlite.ts              # open DB + load sqlite-vec + schema
│   ├── types.ts
│   └── router.ts              # SemanticRouter (fase 2)
├── examples/
│   └── embeddingExample.ts
└── data/                      # gitignored
    └── memory.db
```

---

## 9. Fora de escopo (v1)

- Multi-tenancy / isolamento por projeto
- Quantização de vetores (int8/bit)
- Hybrid search (BM25 + vector)
- UI / dashboard
- Sincronização entre máquinas
- Dimensões diferentes de 768 (trocar modelo exige migration da vec0)

---

## 10. Critérios de aceite

- [ ] `EmbeddingStore.open()` cria schema idempotente
- [ ] `add` + `search` retornam hits ordenados por similaridade
- [ ] Filtro por `kind` funciona
- [ ] Cache com `minScore=0.93` evita reexecução em input idêntico/quase
      idêntico
- [ ] DB em disco persiste entre processos Deno
- [ ] `:memory:` funciona em testes
- [ ] Transações não deixam documento órfão sem vetor (ou vice-versa)
- [ ] Exemplo em `embeddingExample.ts` roda com `nomic-embed-text` local

---

## 11. Riscos e decisões abertas

| Item                   | Decisão proposta                               | Alternativa                                 |
| ---------------------- | ---------------------------------------------- | ------------------------------------------- |
| Distância L2 vs coseno | Normalizar vetores no insert + score `1/(1+d)` | Usar só L2 bruto                            |
| Dimensão fixa 768      | Travada no schema vec0                         | Migration se mudar modelo                   |
| Driver SQLite          | `@db/sqlite` + `sqlite-vec`                    | Avaliar `node:sqlite` se Deno complicar FFI |
| Tamanho do `text`      | Guardar texto completo                         | Truncar + guardar hash do original          |

---

## 12. Próximos passos de implementação

1. `embeddings/sqlite.ts` — open + load extension + migrate
2. `embeddings/client.ts` — Ollama embed
3. `embeddings/store.ts` — CRUD + search
4. `examples/embeddingExample.ts` — smoke test
5. (Fase 2) `router.ts` + integração com pipelines
