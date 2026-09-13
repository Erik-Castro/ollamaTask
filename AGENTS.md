# AGENTS.md

## What This Is

Deno 2.x TypeScript library wrapping the Ollama streaming chat API. No
`package.json`/`node_modules` — dependencies are `npm:`/JSR specifiers in
`deno.json`. This is a **library**, not an app: no build step, consumers import
`src/` files directly.

## Layout & Entrypoints

- `src/engine/` — the ReAct engine core, copied and extended from a sibling
  project. Single barrel (`src/engine/mod.ts`) exporting `ReAct`,
  `ResponsesCall`, `defaultResponsesCall`, `createClient`, `ToolRegistry`,
  events and config. Multimodal `runParts()`, `initialMessages`, `modelParams`
  and `format` extensions live here.
- `src/ollamaTask.ts` — main fluent client (`ollamaTask`). It is now a **facade
  over the engine's `ReAct` loop**: `execute()` translates `AgentEvent` →
  `StreamEvent`. Public API and types are preserved.
- `src/ollamaPipeline.ts` — multi-stage pipeline (state preserved on each stage
  via `transform`).
- `src/ragIntegration.ts` — RAG integration types (`RAGConfig`), helpers
  (`searchContext`, `formatContext`, `createRAGTool`).
- `src/tools/` — zero-dependency agent tool suite (Now, Calculator, ListDir,
  FileRead, FileWrite, FileEdit, CodeSearch, Which, RunCommand, WebSearch,
  WebFetch, StateStore, RAGSearch + html/net helpers). Shared file-tool core
  lives in `src/tools/file-core.ts` (`FsError`, observed-state, atomic write,
  line windowing). Single-file modules returning serializable structured results
  that map onto `ToolDefinition`/`ToolHandler` pairs.
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
deno task test    # offline suite: engine + existing tests, excludes tests/integration
deno task test:int  # E2E against a running Ollama (tests/integration/)
```

`deno.json` uses `"nodeModulesDir": "auto"` because
`better-sqlite3-multiple-ciphers` ships a Node-API addon. On first run after a
clean checkout, install so the addon is compiled/linked:

```bash
deno install --allow-scripts='npm:better-sqlite3-multiple-ciphers' --entrypoint src/memories/database.ts
```

## Platform notes (Termux/Android)

- `better-sqlite3-multiple-ciphers` (native addon) and `sqlite-vector` are
  unsupported on Termux/Android. `tests/store.test.ts` and `tests/rag.test.ts`
  detect the platform (`Deno.build.os === "android"` + `$TERMUX_VERSION`) and
  skip those tests; they report as **ignored**, so the offline suite stays
  green. On desktop Linux they run normally.
- The native addon works on Termux only when `node_modules/` exists with a
  locally compiled binary; do not delete `node_modules/` on this platform.

## Gotchas

- Ollama must be running locally. **No mock/offline mode exists.** For a remote
  host, set `OLLAMA_HOST` or pass a custom client
  (`new
  ollama.Ollama({ host })`) — see README "Running with a Different
  Host".
- `deno.lock` and `node_modules/` are gitignored — they regenerate locally.
  `deno.lock` regenerates on first run; `node_modules/` needs the `deno install`
  above (or will be created lazily wherever local addons are needed).
- File tools enforce a read-before-write policy: `FileWrite`/`FileEdit` require
  a prior `FileRead` of the path in the same process (version-guarded,
  `FS_NOT_OBSERVED`/`FS_STALE_VERSION`). The observation map is module-global —
  call `resetFileObservation()` in long-running servers (already done in
  `buildServer()`) and use `FileWriteUnconditional`/`FileEditUnconditional` to
  skip the guard.
- `data/` is `.gitignore`d local runtime data; `StateStore` persists to
  `data/state.json` by default and `CodeSearch` excludes `data/`.
- Formatter/linting are stock `deno fmt`/`deno lint` with no config overrides —
  run `deno fmt` on touched files instead of hand-formatting.
- The Deno CLI resolves `deno.json` relative to the entrypoint module: scripts
  run from outside the repo (e.g. `deno run /tmp/foo.ts`) lose the import map
  and fail with "import not a dependency". Keep smoke scripts inside the repo.
