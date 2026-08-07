export interface WhichResult {
  binary: string;
  exists: boolean;
  path: string | null;
}

const isExecutable = async (candidate: string): Promise<boolean> => {
  try {
    return (await Deno.stat(candidate)).isFile;
  } catch {
    return false;
  }
};

/**
 * Verifica se um binário existe no PATH. Escaneia `PATH` com `Deno.stat`
 * (sem subprocess), então só precisa de `--allow-env` e `--allow-read`.
 */
export const Which = async (binary: string): Promise<WhichResult> => {
  const path = Deno.env.get("PATH") ?? "";

  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/${binary}`;
    if (await isExecutable(candidate)) {
      return { binary, exists: true, path: candidate };
    }
  }

  return { binary, exists: false, path: null };
};
