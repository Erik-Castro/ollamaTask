export interface FileReadResult {
  path: string;
  content: string;
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 8000;

/**
 * Lê um arquivo de texto local sob demanda e retorna o conteúdo de forma
 * estruturada: { path, content, truncated }. O conteúdo é truncado para
 * `maxChars` para não estourar o contexto do modelo.
 */
export const FileRead = async (
  path: string,
  options: { maxChars?: number } = {},
): Promise<FileReadResult> => {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const content = await Deno.readTextFile(path);

  return {
    path,
    content: content.length > maxChars ? content.slice(0, maxChars) : content,
    truncated: content.length > maxChars,
  };
};
