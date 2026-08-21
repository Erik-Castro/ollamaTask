import type { ToolDefinition, ToolHandler } from "../ollamaTask.ts";

export interface StateStoreOptions {
  path?: string;
}

export interface StateStoreResult {
  key: string;
  value: unknown;
}

export interface StateStoreListResult {
  keys: string[];
  count: number;
}

const DEFAULT_STORE_PATH = "data/state.json";

const ensureDir = async (storePath: string): Promise<void> => {
  const slash = storePath.lastIndexOf("/");
  if (slash <= 0) return;
  const dir = storePath.slice(0, slash);
  if (!dir || dir === ".") return;
  await Deno.mkdir(dir, { recursive: true });
};

/**
 * Store de estado chave-valor persistente em JSON (data/state.json por
 * padrão — pasta gitignorada). Precisa de --allow-read/--allow-write na
 * pasta do arquivo. Cada instância mantém seu próprio cache.
 */
export class StateStore {
  #cache: Record<string, unknown> | null = null;
  #path: string;

  constructor(options: StateStoreOptions = {}) {
    this.#path = options.path ?? DEFAULT_STORE_PATH;
  }

  async get(key: string): Promise<StateStoreResult> {
    const data = await this.#load();
    return {
      key,
      value: Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null,
    };
  }

  async set(key: string, value: unknown): Promise<StateStoreResult> {
    const data = await this.#load();
    data[key] = value;
    await this.#save(data);
    return { key, value };
  }

  async delete(key: string): Promise<StateStoreResult> {
    const data = await this.#load();
    const existed = Object.prototype.hasOwnProperty.call(data, key);
    delete data[key];
    await this.#save(data);
    return { key, value: existed };
  }

  async list(): Promise<StateStoreListResult> {
    const data = await this.#load();
    const keys = Object.keys(data);
    return { keys, count: keys.length };
  }

  clear(): void {
    this.#cache = null;
  }

  async #load(): Promise<Record<string, unknown>> {
    if (this.#cache) return this.#cache;
    try {
      this.#cache = JSON.parse(
        await Deno.readTextFile(this.#path),
      ) as Record<string, unknown>;
    } catch {
      this.#cache = {};
    }
    return this.#cache;
  }

  async #save(data: Record<string, unknown>): Promise<void> {
    this.#cache = data;
    await ensureDir(this.#path);
    await Deno.writeTextFile(this.#path, JSON.stringify(data, null, 2));
  }
}

export function StateStoreGetTool(
  store: StateStore,
): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      type: "function",
      function: {
        name: "state_get",
        description: "Read a key from the persistent K-V store.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Key name" },
          },
          required: ["key"],
        },
      },
    },
    handler: {
      name: "state_get",
      execute: (args) => store.get(args.key as string),
    },
  };
}

export function StateStoreSetTool(
  store: StateStore,
): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      type: "function",
      function: {
        name: "state_set",
        description: "Persist a value under a key in the K-V store.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Key name" },
            value: { type: "string", description: "Value to store" },
          },
          required: ["key", "value"],
        },
      },
    },
    handler: {
      name: "state_set",
      execute: (args) => store.set(args.key as string, args.value),
    },
  };
}

export function StateStoreDeleteTool(
  store: StateStore,
): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      type: "function",
      function: {
        name: "state_delete",
        description: "Delete a key from the K-V store.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Key name" },
          },
          required: ["key"],
        },
      },
    },
    handler: {
      name: "state_delete",
      execute: (args) => store.delete(args.key as string),
    },
  };
}

export function StateStoreListTool(
  store: StateStore,
): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      type: "function",
      function: {
        name: "state_list",
        description: "List all keys in the K-V store.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: {
      name: "state_list",
      execute: () => store.list(),
    },
  };
}

export function StateStoreAllTools(store: StateStore): {
  definitions: ToolDefinition[];
  handlers: ToolHandler[];
} {
  const get = StateStoreGetTool(store);
  const set = StateStoreSetTool(store);
  const del = StateStoreDeleteTool(store);
  const list = StateStoreListTool(store);
  return {
    definitions: [
      get.definition,
      set.definition,
      del.definition,
      list.definition,
    ],
    handlers: [get.handler, set.handler, del.handler, list.handler],
  };
}
