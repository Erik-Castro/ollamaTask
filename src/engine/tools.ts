/**
 * Registro e execução segura de ferramentas (spec §6.1/§6.3).
 *
 * `executeSafe` nunca lança: retorna `ToolResult` com `ok:false` + mensagem,
 * o que alimenta a camada de auto-correção (suggests.md §C). A validação de
 * parâmetros usa **Zod** (`Tool.parameters`), convertido para JSON Schema
 * (`z.toJSONSchema`) ao anunciar a tool ao modelo.
 *
 * @module tools
 */
import { z } from "zod";
import type { Responses } from "openai/resources/responses";
import type { Tool, ToolResult } from "./types.ts";

/**
 * Formata os issues de um ZodError numa única string legível.
 *
 * Cada issue vira `$.caminho: mensagem` (ex.: `$.texto: Required`); o modelo
 * que recebe a falha no self-healing (§C) consegue corrigir com precisão.
 *
 * @param error Erro de validação do Zod.
 * @returns Mensagem consolidada, ex.: `$.id: Expected number, received string`.
 * @example
 * ```ts
 * formatZodIssues(z.string().safeParse(42).error!);
 * // "Invalid input: expected string, received number"
 * ```
 */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Converte uma `Tool` do harness para o formato do SDK (FunctionTool).
 *
 * Usada pelo loop ReAct para anunciar as ferramentas ao modelo via
 * `tools` na chamada de cada round. O schema Zod vira JSON Schema
 * (`z.toJSONSchema`), sem a keyword `$schema` para não atritar com providers
 * locais (ex.: Ollama).
 *
 * @param tool Ferramenta do harness (veja {@link Tool}).
 * @returns Tool no formato `Responses.Tool` (type `"function"`).
 * @example
 * ```ts
 * import { z } from "zod";
 * const tool: Tool = {
 *   name: "uppercase",
 *   description: "Converte texto para maiúsculas.",
 *   parameters: z.object({ text: z.string() }).strict(),
 *   execute: ({ text }) => String(text).toUpperCase(),
 * };
 *
 * toOpenAITool(tool);
 * // {
 * //   type: "function",
 * //   name: "uppercase",
 * //   description: "Converte texto para maiúsculas.",
 * //   parameters: { type: "object", properties: { text: { type: "string" } },
 * //                  required: ["text"], additionalProperties: false },
 * //   strict: false,
 * // }
 * ```
 */
export function toOpenAITool(tool: Tool): Responses.Tool {
  let parameters: Record<string, unknown> | null = null;
  if (tool.parametersJsonSchema) {
    const { $schema: _schema, ...rest } = tool.parametersJsonSchema;
    parameters = rest;
  } else if (tool.parameters) {
    const { $schema: _schema, ...rest } = z.toJSONSchema(tool.parameters);
    parameters = rest;
  }
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters,
    strict: false,
  };
}

/**
 * Registro de ferramentas do harness (spec §5 `registryTool`).
 *
 * Encapsula um `Map<string, Tool>` por nome. A instância exposta pelo
 * `ReAct` é privada; as ferramentas entram via `ReAct.registryTool(...)`.
 *
 * @example
 * ```ts
 * const registry = new ToolRegistry();
 * registry.register(uppercaseTool); // encadeável
 * registry.names();                 // ["uppercase"]
 * ```
 */
export class ToolRegistry {
  private readonly _tools = new Map<string, Tool>();

  /**
   * Registra uma ferramenta (spec §5 `registryTool`).
   *
   * @param tool Ferramenta a registrar.
   * @returns O próprio registro (encadeamento).
   * @throws {Error} Se já existir uma ferramenta com o mesmo nome.
   * @example
   * ```ts
   * const registry = new ToolRegistry();
   * registry.register({ name: "a", description: "", execute: () => "ok" });
   * registry.register({ name: "a", description: "", execute: () => "ok" });
   * // throws Error: Ferramenta já registrada: "a"
   * ```
   */
  register(tool: Tool): this {
    if (this._tools.has(tool.name)) {
      throw new Error(`Ferramenta já registrada: "${tool.name}"`);
    }
    this._tools.set(tool.name, tool);
    return this;
  }

  /**
   * Obtém uma ferramenta registrada por nome.
   *
   * @param name Nome da ferramenta.
   * @returns A `Tool` ou `undefined` se não registrada.
   */
  get(name: string): Tool | undefined {
    return this._tools.get(name);
  }

  /**
   * Lista todas as ferramentas registradas (ordem de inserção).
   *
   * @returns Array com as ferramentas.
   * @example
   * ```ts
   * registry.list().map((t) => t.name); // ["uppercase", "delete_record"]
   * ```
   */
  list(): Tool[] {
    return [...this._tools.values()];
  }

  /**
   * Lista os nomes das ferramentas registradas.
   *
   * @returns Nomes em ordem de inserção.
   */
  names(): string[] {
    return [...this._tools.keys()];
  }

  /**
   * Executa com sandboxing: parse de JSON, validação Zod e try/catch.
   * Nunca lança — falhas viram `{ ok:false, error }` para o self-healing (§C).
   *
   * Fluxo de validação:
   * 1. Tool existe? (senão `Ferramenta desconhecida`)
   * 2. `argsJson` parseia como objeto? (senão `Argumentos JSON inválidos`)
   * 3. `schema.safeParse(params)` passa? (senão issues formatados do Zod)
   * 4. `tool.execute(params)` não lança? (senão `Falha ao executar`)
   *
   * @param name Nome da ferramenta registrada.
   * @param argsJson Argumentos em JSON string (ex.: `'{"text":"oi"}'`).
   * @returns `{ ok:true, output }` ou `{ ok:false, error }`.
   * @example
   * ```ts
   * const ok = await registry.executeSafe("uppercase", '{"text":"oi"}');
   * // { ok: true, output: "OI" }
   *
   * const badJson = await registry.executeSafe("uppercase", "{nope");
   * // { ok: false, error: "Argumentos JSON inválidos: ..." }
   *
   * const badSchema = await registry.executeSafe("uppercase", '{"text":123}');
   * // { ok: false, error: "$.text: Invalid input: expected string, received number" }
   * ```
   */
  async executeSafe(name: string, argsJson: string): Promise<ToolResult> {
    const tool = this._tools.get(name);
    if (!tool) {
      const names = this.names();
      const available = names.length === 0 ? "nenhuma" : names.join(", ");
      const plural = names.length === 1 ? "Disponível" : "Disponíveis";
      return {
        ok: false,
        error: `Ferramenta desconhecida "${name}". ${plural}: ${available}`,
      };
    }

    let params: Record<string, unknown>;
    try {
      params = JSON.parse(argsJson);
    } catch (cause) {
      return {
        ok: false,
        error: `Argumentos JSON inválidos: ${(cause as Error).message}`,
      };
    }
    if (
      typeof params !== "object" || params === null || Array.isArray(params)
    ) {
      return { ok: false, error: "Os argumentos devem ser um objeto JSON" };
    }

    if (tool.parameters) {
      const parsed = tool.parameters.safeParse(params);
      if (!parsed.success) {
        return { ok: false, error: formatZodIssues(parsed.error) };
      }
      params = parsed.data as unknown as Record<string, unknown>;
    }

    try {
      const output = await tool.execute(params);
      return { ok: true, output };
    } catch (cause) {
      return {
        ok: false,
        error: `Falha ao executar: ${(cause as Error).message}`,
      };
    }
  }
}
