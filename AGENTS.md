# AGENTS.md

## What This Is

A Deno 2.x TypeScript library (`ollamaTask`) wrapping the Ollama streaming chat
API. Single file in `src/ollamaTask.ts` plus `src/ollamaPipeline.ts` and
`src/embeddings/`. Examples in `examples/`.

## Runtime & Toolchain

- **Deno 2.x** — no `package.json`, no `node_modules`. Config in `deno.json`.
- Dependencies use `npm:` specifiers (e.g. `npm:ollama@^0.6.3`).
- No test runner configured. No lint config. No CI workflows.
- No formatter config — follow existing code style in `src/`.

## Running Examples

All examples require a running Ollama instance on `http://127.0.0.1:11434`.

```bash
deno run --allow-net=127.0.0.1:11434 examples/<file>.ts
```

Quick dev mode (watches `basic-chat.ts`):

```bash
deno task dev
```

## Key Conventions

- Library files live in `src/`. Entry points: `src/ollamaTask.ts`,
  `src/ollamaPipeline.ts`.
- `src/tools/` is the tool suite (Now, Calculator, ListDir, FileRead, FileWrite,
  CodeSearch, Which, RunCommand, WebSearch, WebFetch, StateStore + html/net
  helpers) — zero-dependency, structured-results modules meant for tool-calling
  pipelines.
- `src/embeddings/` is a separate module (cache, client, router, sqlite store).
- `data/` is `.gitignore`d — local runtime data (incl. `data/state.json`),
  not source.
- `docs/` contains design specs, not user-facing docs.
- Examples are self-contained runnable demos, not tests.

## Gotchas

- This is a **library**, not an app. There is no build step — consumers import
  directly.
- Ollama must be running locally. No mock/offline mode exists.
- `deno.lock` is gitignored — lockfile regenerates on first run.
