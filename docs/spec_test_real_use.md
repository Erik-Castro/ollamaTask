# Spec: Teste de Uso Real — Semantic Memory Layer

**Projeto:** ollamaTask  
**Referência:** Spec Semantic Memory Layer (SQLite + sqlite-vec)  
**Tipo:** Teste de uso end-to-end (exemplo real, não unitário isolado)  
**Arquivo sugerido:** `examples/semanticMemoryUsage.ts`  
**Status:** Draft  

---

## 1. Objetivo do teste

Validar, em um fluxo **realista de desenvolvimento local**, que a camada de memória semântica:

1. Persiste embeddings em SQLite + sqlite-vec  
2. Faz **cache semântico** (não reprocessa input quase idêntico)  
3. Recupera **histórico de runs** como contexto  
4. **Roteia** prompts para pipelines diferentes conforme a intenção  
5. Sobrevive a **reinício do processo** (persistência em disco)

O teste deve ser executável com:

```bash
deno run --allow-net=127.0.0.1:11434 --allow-read --allow-write --allow-ffi examples/semanticMemoryUsage.ts
```

---

## 2. Pré-requisitos

| Item | Requisito |
|------|-----------|
| Ollama | Rodando em `http://127.0.0.1:11434` |
| Modelo embed | `nomic-embed-text` puxado |
| Modelos LLM | Pelo menos: `LFM2.5:350M`, `lfm2.5-thinking:latest`, `qwen3.5:2b` |
| Dependências | `npm:sqlite-vec`, `jsr:@db/sqlite`, `npm:ollama` |
| Disco | Pasta `./data/` gravável (ou path temporário) |

Se algum modelo faltar, o teste deve falhar com mensagem clara (`ollama pull <model>`).

---

## 3. Cenário narrativo (uso real)

Simular um assistente de código local que:

- Recebe pedidos mistos (código, raciocínio, classificação rápida)  
- Escolhe o pipeline certo via embeddings  
- Guarda cada execução  
- Na segunda vez que o usuário pergunta algo **quase igual**, devolve do cache  
- Na terceira vez, com pergunta **relacionada**, injeta contexto do histórico

### Personas / inputs

| # | Input do usuário | Intenção esperada |
|---|------------------|-------------------|
| A | `"Crie uma função TypeScript que valide e-mail com regex"` | codegen |
| B | `"Escreva uma função TS para validar email usando expressão regular"` | codegen (quase A → **cache hit**) |
| C | `"Explique passo a passo como essa validação de e-mail funciona"` | reasoning (relacionado a A → **contexto do histórico**) |
| D | `"Classifique: 'O deploy falhou de novo na staging' — bug ou feature?"` | quick |

---

## 4. Setup do teste

```ts
const DB_PATH = "./data/usage-test.db";
// no início: apagar DB se existir, para teste determinístico
```

### 4.1 Inicialização

1. Remover `DB_PATH` se existir  
2. `const store = new EmbeddingStore({ dbPath: DB_PATH })`  
3. `await store.open()`  
4. Verificar `stats().total === 0`  
5. Registrar 3 rotas no `SemanticRouter`:

| Rota | Exemplos (mín. 3 cada) | Pipeline |
|------|------------------------|----------|
| `codegen` | “escreva uma função…”, “crie um endpoint…”, “gere código typescript…” | `lfm2.5-thinking` (plano curto) → `qwen3.5:2b` (código) |
| `reasoning` | “explique como…”, “por que isso acontece…”, “raciocine passo a passo…” | `lfm2.5-thinking` ou `deepseek-r1:1.5b` |
| `quick` | “classifique…”, “resuma em uma frase…”, “isso é positivo ou negativo?” | `LFM2.5:350M` |

Cada exemplo de rota deve ser persistido como `kind: "route_example"`.

---

## 5. Passos do teste (assertivos)

### Passo 1 — Primeira execução (codegen, miss de cache)

```
input = A
resultado = await router.route(A)   // ou cachedRun + route
```

**Asserts:**

| ID | Condição |
|----|----------|
| T1.1 | `resultado.route === "codegen"` |
| T1.2 | `resultado.score >= 0.5` (limiar mínimo razoável) |
| T1.3 | `resultado.result.content.length > 50` |
| T1.4 | `store.stats()` → `byKind.run >= 1` e/ou `byKind.cache >= 1` |
| T1.5 | Conteúdo menciona validação / email / regex (checagem textual simples, case-insensitive) |

Registrar tokens e tempo (log, não assert rígido).

---

### Passo 2 — Input quase idêntico (cache hit)

```
input = B   // parafrase de A
resultado = await router.route(B)  // com cachedRun ativo, minScore = 0.93
```

**Asserts:**

| ID | Condição |
|----|----------|
| T2.1 | Cache **hit** (flag ou `inputTokens === 0` / metadata `fromCache: true`) |
| T2.2 | Conteúdo semanticamente alinhado ao de A (ou idêntico se cache devolve output anterior) |
| T2.3 | Tempo total **menor** que o do Passo 1 (log + assert relativo, ex. `< 50%` se ambiente estável; senão apenas log) |
| T2.4 | Não incrementa `byKind.run` de forma que indique reprocessamento completo (ou documentar se o design grava cache hit de outro modo) |

> Se o cache for implementado só no `cachedRun` e o router sempre gravar runs, documentar o comportamento esperado neste passo.

---

### Passo 3 — Pergunta relacionada (retrieval de histórico)

```
input = C
resultado = await router.route(C)
```

**Asserts:**

| ID | Condição |
|----|----------|
| T3.1 | `resultado.route === "reasoning"` |
| T3.2 | O prompt efetivo da stage de reasoning **inclui contexto** recuperado de runs anteriores (verificar via log do `transform` / system, ou via metadata `contextHits >= 1`) |
| T3.3 | Resposta referencia validação de e-mail / regex (não resposta genérica vazia) |
| T3.4 | Novo documento `kind: "run"` persistido |

---

### Passo 4 — Classificação rápida

```
input = D
resultado = await router.route(D)
```

**Asserts:**

| ID | Condição |
|----|----------|
| T4.1 | `resultado.route === "quick"` |
| T4.2 | Resposta curta (ex. `< 300` caracteres) ou contém “bug” / “falha” / classificação explícita |
| T4.3 | Modelo usado na rota quick é o leve (`LFM2.5:350M` ou equivalente registrado) |

---

### Passo 5 — Persistência entre processos

```
store.close()
// novo processo lógico no mesmo script:
const store2 = new EmbeddingStore({ dbPath: DB_PATH })
await store2.open()
const stats = await store2.stats()
const hits = await store2.search({ query: A, topK: 3, kind: "run" })
```

**Asserts:**

| ID | Condição |
|----|----------|
| T5.1 | `stats.total >= 3` (runs/cache/exemplos conforme design) |
| T5.2 | `hits.length >= 1` |
| T5.3 | `hits[0].text` relacionado a validação de e-mail |
| T5.4 | `hits[0].score > 0` |

---

### Passo 6 — Isolamento por kind

```
const onlyExamples = await store2.search({
  query: "escreva código typescript",
  topK: 5,
  kind: "route_example",
})
const onlyRuns = await store2.search({
  query: "escreva código typescript",
  topK: 5,
  kind: "run",
})
```

**Asserts:**

| ID | Condição |
|----|----------|
| T6.1 | Todos em `onlyExamples` têm `kind === "route_example"` |
| T6.2 | Todos em `onlyRuns` têm `kind === "run"` (ou `cache`, se unificados — documentar) |
| T6.3 | Nenhum example aparece em `onlyRuns` e vice-versa |

---

## 6. Formato de saída do teste

O script deve imprimir um relatório legível:

```
=== Semantic Memory Usage Test ===
DB: ./data/usage-test.db

[Passo 1] codegen — MISS
  route=codegen score=0.81
  tokens: 120 in / 340 out
  time: 4.2s
  T1.1..T1.5 OK

[Passo 2] codegen — CACHE HIT
  fromCache=true
  time: 0.3s
  T2.1..T2.4 OK

[Passo 3] reasoning + context
  contextHits=2
  T3.1..T3.4 OK

[Passo 4] quick
  T4.1..T4.3 OK

[Passo 5] persistence
  total=12 byKind={ route_example: 9, run: 2, cache: 1 }
  T5.1..T5.4 OK

[Passo 6] kind filter
  T6.1..T6.3 OK

=== RESULTADO: 18/18 asserts passed ===
```

Exit code:

- `0` se todos os asserts passarem  
- `1` se qualquer assert falhar (com ID do assert e motivo)

---

## 7. Critérios de sucesso globais

O teste de uso é considerado **aprovado** quando:

1. Todos os asserts T1–T6 passam  
2. O arquivo `DB_PATH` existe ao final e tem tamanho `> 0`  
3. Não há documentos órfãos (todo `documents.id` tem vetor em `vec_documents` — checagem opcional via SQL)  
4. O fluxo completo roda em máquina local sem serviços cloud  

---

## 8. Tolerâncias e flakiness

| Aspecto | Política |
|---------|----------|
| Rota escolhida | Modelos pequenos podem errar; se score da rota esperada for o **maior**, aceitar; se empatar, preferir a esperada |
| Cache threshold | `minScore = 0.93` para B vs A; se ambiente gerar score menor, logar score e falhar de forma explícita |
| Tempo | Assert de tempo no Passo 2 é **soft** (warn se não for mais rápido; fail só se configurado `STRICT_TIMING=1`) |
| Conteúdo LLM | Asserts textuais usam `includes` case-insensitive, não match exato de string longa |

---

## 9. Limpeza

Ao final (ou flag `--keep-db`):

- Default: manter `DB_PATH` para inspeção manual (`sqlite3 data/usage-test.db`)  
- Com `CLEANUP=1`: apagar DB e diretório vazio  

---

## 10. Fora de escopo deste teste

- Benchmark de latência de embedding  
- Testes de concorrência / multi-writer  
- Troca de modelo de embedding / migration de dimensão  
- UI  
- Cloud models  

---

## 11. Mapeamento Spec → Teste

| Feature da Spec de memória | Passo que valida |
|----------------------------|------------------|
| Schema + open idempotente | Setup + Passo 5 |
| `add` + `search` | Passos 1, 3, 5 |
| Filtro por `kind` | Passo 6 |
| Cache semântico | Passo 2 |
| Memória de runs / contexto | Passo 3 |
| SemanticRouter | Passos 1, 3, 4 |
| Persistência em disco | Passo 5 |
| Transações (sem órfãos) | Opcional no Passo 5 |

---

## 12. Próximo passo de implementação

1. Implementar `EmbeddingStore` + `EmbeddingClient` conforme Spec anterior  
2. Implementar `SemanticRouter` mínimo  
3. Escrever `examples/semanticMemoryUsage.ts` seguindo **exatamente** os passos e asserts desta Spec  
4. Rodar e ajustar limiares (`minScore`, score de rota) com base em resultados reais dos modelos locais  

Se quiser, no próximo passo monto o esqueleto do `semanticMemoryUsage.ts` com os asserts já nomeados (T1.1, T2.1, …) prontos para preencher a implementação.
