import { Which } from "./Which.ts";

export interface CodeMatch {
  file: string;
  line: number;
  snippet: string;
}

export interface CodeSearchResult {
  pattern: string;
  backend: "rg" | "deno";
  matches: CodeMatch[];
  truncated: boolean;
}

export interface CodeSearchOptions {
  include?: string[];
  exclude?: string[];
  limit?: number;
  snippetChars?: number;
  backend?: "rg" | "deno" | "auto";
  root?: string;
}

const DEFAULT_EXCLUDE = [".git", "node_modules", "data"];
const DEFAULT_LIMIT = 50;
const DEFAULT_SNIPPET_CHARS = 120;

const runRg = async (
  pattern: string,
  options: Required<CodeSearchOptions>,
): Promise<{ matches: CodeMatch[]; truncated: boolean }> => {
  const args = ["--line-number", "--no-heading", "--color", "never"];
  for (const ext of options.include) args.push("-g", `*.${ext}`);
  for (const dir of options.exclude) args.push("--glob", `!${dir}/**`);
  args.push(pattern, options.root);

  const command = new Deno.Command("rg", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();

  if (code === 1) return { matches: [], truncated: false };
  if (code !== 0) {
    throw new Error(
      `rg falhou (${code}): ${new TextDecoder().decode(stderr).trim()}`,
    );
  }

  const lines = new TextDecoder().decode(stdout).split("\n").filter(Boolean);
  const matches: CodeMatch[] = lines.slice(0, options.limit).map((rawLine) => {
    const first = rawLine.indexOf(":");
    const second = rawLine.indexOf(":", first + 1);
    let snippet = rawLine.slice(second + 1);
    if (snippet.length > options.snippetChars) {
      snippet = snippet.slice(0, options.snippetChars);
    }
    return {
      file: rawLine.slice(0, first),
      line: Number(rawLine.slice(first + 1, second)),
      snippet,
    };
  });

  return { matches, truncated: lines.length > options.limit };
};

const walkFiles = async (
  dir: string,
  options: Required<CodeSearchOptions>,
  acc: string[],
): Promise<void> => {
  for await (const entry of Deno.readDir(dir)) {
    if (options.exclude.includes(entry.name)) continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      await walkFiles(full, options, acc);
    } else if (entry.isFile) {
      if (
        options.include.length &&
        !options.include.some((ext) => full.endsWith(`.${ext}`))
      ) {
        continue;
      }
      acc.push(full);
    }
  }
};

const runDeno = async (
  pattern: string,
  options: Required<CodeSearchOptions>,
): Promise<{ matches: CodeMatch[]; truncated: boolean }> => {
  const regex = new RegExp(pattern);
  const files: string[] = [];
  await walkFiles(options.root, options, files);

  const matches: CodeMatch[] = [];
  let truncated = false;

  for (const file of files) {
    if (matches.length >= options.limit) {
      truncated = true;
      break;
    }
    const lines = (await Deno.readTextFile(file)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= options.limit) {
        truncated = true;
        break;
      }
      if (regex.test(lines[i])) {
        let snippet = lines[i].trim();
        if (snippet.length > options.snippetChars) {
          snippet = snippet.slice(0, options.snippetChars);
        }
        matches.push({ file, line: i + 1, snippet });
      }
    }
  }

  return { matches, truncated };
};

/**
 * Busca `pattern` (regex) em arquivos locais. Backend "auto" decide aqui:
 * usa `rg` se o binário existir (via Which), senão cai para uma varredura
 * pura em Deno. Retorna os matches de forma estruturada.
 */
export const CodeSearch = async (
  pattern: string,
  options: CodeSearchOptions = {},
): Promise<CodeSearchResult> => {
  const opts: Required<CodeSearchOptions> = {
    include: options.include ?? [],
    exclude: options.exclude ?? DEFAULT_EXCLUDE,
    limit: options.limit ?? DEFAULT_LIMIT,
    snippetChars: options.snippetChars ?? DEFAULT_SNIPPET_CHARS,
    backend: options.backend ?? "auto",
    root: options.root ?? ".",
  };

  let backend: "rg" | "deno" = "deno";
  if (opts.backend === "rg") backend = "rg";
  else if (opts.backend === "auto") {
    backend = (await Which("rg")).exists ? "rg" : "deno";
  }

  try {
    const result = backend === "rg"
      ? await runRg(pattern, opts)
      : await runDeno(pattern, opts);
    return { pattern, backend, ...result };
  } catch (error) {
    if (opts.backend !== "auto") throw error;
    const fallback = await runDeno(pattern, opts);
    return { pattern, backend: "deno", ...fallback };
  }
};
