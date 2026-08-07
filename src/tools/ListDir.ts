export interface DirEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
}

export interface ListDirResult {
  path: string;
  entries: DirEntry[];
}

/**
 * Lista as entradas de um diretório: dirs primeiro, depois alfabético.
 * Sem `stat` por entrada (permissão mínima).
 */
export const ListDir = async (path = "."): Promise<ListDirResult> => {
  const entries: DirEntry[] = [];

  for await (const entry of Deno.readDir(path)) {
    const kind: DirEntry["kind"] = entry.isDirectory
      ? "dir"
      : entry.isSymlink
      ? "symlink"
      : "file";
    entries.push({ name: entry.name, kind });
  }

  entries.sort((a, b) => {
    if (a.kind === "dir" && b.kind !== "dir") return -1;
    if (a.kind !== "dir" && b.kind === "dir") return 1;
    return a.name.localeCompare(b.name);
  });

  return { path, entries };
};
