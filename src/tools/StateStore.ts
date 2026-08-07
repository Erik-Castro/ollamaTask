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

let cache: Record<string, unknown> | null = null;

const ensureDir = async (storePath: string): Promise<void> => {
  const slash = storePath.lastIndexOf("/");
  if (slash <= 0) return;
  const dir = storePath.slice(0, slash);
  if (!dir || dir === ".") return;
  await Deno.mkdir(dir, { recursive: true });
};

const load = async (storePath: string): Promise<Record<string, unknown>> => {
  if (cache) return cache;
  try {
    cache = JSON.parse(await Deno.readTextFile(storePath)) as Record<
      string,
      unknown
    >;
  } catch {
    cache = {};
  }
  return cache;
};

const save = async (
  storePath: string,
  data: Record<string, unknown>,
): Promise<void> => {
  cache = data;
  await ensureDir(storePath);
  await Deno.writeTextFile(storePath, JSON.stringify(data, null, 2));
};

/**
 * Store de estado chave-valor persistente em JSON (data/state.json por
 * padrão — pasta gitignorada). Precisa de --allow-read/--allow-write na
 * pasta do arquivo. É carregado em cache na primeira chamada.
 */
export const StateStoreGet = async (
  key: string,
  options: StateStoreOptions = {},
): Promise<StateStoreResult> => {
  const data = await load(options.path ?? DEFAULT_STORE_PATH);
  return {
    key,
    value: Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null,
  };
};

export const StateStoreSet = async (
  key: string,
  value: unknown,
  options: StateStoreOptions = {},
): Promise<StateStoreResult> => {
  const storePath = options.path ?? DEFAULT_STORE_PATH;
  const data = await load(storePath);
  data[key] = value;
  await save(storePath, data);
  return { key, value };
};

export const StateStoreDelete = async (
  key: string,
  options: StateStoreOptions = {},
): Promise<StateStoreResult> => {
  const storePath = options.path ?? DEFAULT_STORE_PATH;
  const data = await load(storePath);
  const deleted = Object.prototype.hasOwnProperty.call(data, key);
  delete data[key];
  await save(storePath, data);
  return { key, value: deleted };
};

export const StateStoreList = async (
  options: StateStoreOptions = {},
): Promise<StateStoreListResult> => {
  const data = await load(options.path ?? DEFAULT_STORE_PATH);
  const keys = Object.keys(data);
  return { keys, count: keys.length };
};
