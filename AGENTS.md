# AGENTS.md

## What This Is

Deno 2.x TypeScript library wrapping the Ollama streaming chat API. No
`package.json`/`node_modules` — dependencies are `npm:`/JSR specifiers in
`deno.json`. This is a **library**, not an app: no build step, consumers import
`src/` files directly.

## Layout & Entrypoints

- `src/ollamaTask.ts` — main fluent client (`ollamaTask`).
  `src/ollamaPipeline.ts` — multi-stage pipeline.
- `src/ragIntegration.ts` — RAG integration types (`RAGConfig`), helpers
  (`searchContext`, `formatContext`, `createRAGTool`).
- `src/tools/` — zero-dependency agent tool suite (Now, Calculator, ListDir,
  FileRead, FileWrite, CodeSearch, Which, RunCommand, WebSearch, WebFetch,
  StateStore, RAGSearch + html/net helpers). Single-file modules returning
  serializable structured results that map onto `ToolDefinition`/`ToolHandler`
  pairs.
- `src/memories/` — RAG library (encrypted SQLite, vector KNN search, semantic
  chunking, multi-provider support). Imported directly from `src/` files.
- `src/mcp/` — MCP support: `MCPBridge` (client) bridges external MCP servers
  (stdio or remote HTTP) into `ollamaTask` tools; `buildServer`/`startServer`
  expose the `src/tools/` suite as an MCP server over stdio. Uses
  `@modelcontextprotocol/sdk` + `zod` via the import map.
- `examples/` — self-contained runnable demos, not tests.
- `docs/` — design specs (written in Portuguese), not user-facing docs. The real
  API reference is `README.md`.

## Commands

```bash
deno task dev     # watch examples/basic-chat.ts
deno task check   # deno lint && deno fmt --check — run before finishing work
deno task test    # deno test --allow-ffi --allow-net --allow-read --allow-write --allow-env --allow-sys
```

Examples require a running Ollama on `http://127.0.0.1:11434`:

```bash
deno run --allow-net=127.0.0.1:11434 examples/<file>.ts
```

Permission flags vary per example: most need only the scoped net flag;
`examples/pipeline-tools.ts` needs broad flags
(`--allow-net --allow-env
--allow-read --allow-write --allow-run`);
`examples/mcp-remote.ts` needs plain `--allow-net` because it reaches
`https://mcp.exa.ai`.

## Current Broken State (verify before relying)

As of this writing:

- `deno task test` fails type-check: test files import `@std/assert`, which is
  missing from `deno.json` imports (fix would be `deno add jsr:@std/assert`),
  and `src/embeddings/store_test.ts` has strict-null errors.
- `deno task check` fails with 3 pre-existing lint errors and ~12 unformatted
  files. If your diff didn't touch them, don't chase them all — just don't make
  them worse.

If both pass when you read this, delete this section.

## Gotchas

- Ollama must be running locally. **No mock/offline mode exists.** For a remote
  host, set `OLLAMA_HOST` or pass a custom client
  (`new
  ollama.Ollama({ host })`) — see README "Running with a Different
  Host".
- `deno.lock` is gitignored — it regenerates locally on first run.
- `data/` is `.gitignore`d local runtime data; `StateStore` persists to
  `data/state.json` by default and `CodeSearch` excludes `data/`.
- Formatter/linting are stock `deno fmt`/`deno lint` with no config overrides —
  run `deno fmt` on touched files instead of hand-formatting.
