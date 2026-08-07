export interface FileReadResult {
  path: string;
  offset: number;
  content: string;
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 8000;
const MAX_UTF8_BYTES = 4;

/**
 * Lê um texto local sob demanda a partir de `offset` (bytes, via
 * `Deno.SeekMode.Start`) e retorna de forma estruturada:
 * { path, offset, content, truncated }. Lê no máximo `maxChars` caracteres —
 * busca com `Deno.seek` em vez de ler o arquivo inteiro, ideal para arquivos
 * grandes em pipelines.
 */
export const FileRead = async (
  path: string,
  options: { maxChars?: number; offset?: number } = {},
): Promise<FileReadResult> => {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const offset = options.offset ?? 0;

  const file = await Deno.open(path, { read: true });
  try {
    await file.seek(Math.max(0, offset), Deno.SeekMode.Start);

    const buffer = new Uint8Array(maxChars * MAX_UTF8_BYTES);
    const bytesRead = await file.read(buffer) ?? 0;
    const size = (await file.stat()).size;

    let content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      buffer.subarray(0, bytesRead),
    );
    const truncated = content.length > maxChars || offset + bytesRead < size;
    if (truncated) content = content.slice(0, maxChars);

    return { path, offset, content, truncated };
  } finally {
    file.close();
  }
};
