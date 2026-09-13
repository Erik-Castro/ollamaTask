/**
 * Barrel público do OllamaTask — ponto único de importação para o consumidor.
 *
 * Re-exporta o motor ReAct (núcleo), a fachada fluente `ollamaTask`, o
 * pipeline multi-stage, RAG helpers e os tipos de configuração que aparecem
 * nas assinaturas públicas.
 *
 * Módulos **não** incluídos aqui (use subpaths quando necessário):
 * - `src/tools/` — toolkit zero-dep para agentes
 * - `src/memories/` — SQLite criptografado + KNN vetorial
 * - `src/mcp/client.ts` / `src/mcp/server.ts` — pontes MCP
 *   (tipos de config pública do pipeline são re-exportados abaixo)
 *
 * @example
 * ```ts
 * import {
 *   ollamaTask,
 *   ollamaPipeline,
 *   ReAct,
 *   type ExecutionResult,
 *   type StageConfig,
 * } from "@erik-castro/ollamatask";
 * ```
 * @module mod
 */
export * from "./engine/mod.ts";
export * from "./ollamaTask.ts";
export * from "./ollamaPipeline.ts";
export * from "./ragIntegration.ts";

// Tipos referenciados na assinatura pública de pipeline/rag sem precisar
// importar o módulo inteiro — mantém a conveniência do barrel.
export type {
  MCPServerConfig,
  RemoteServerConfig,
  StdioServerConfig,
} from "./mcp/client.ts";
export type { RAG } from "./memories/rag.ts";
export type { SearchHit } from "./memories/store.ts";
