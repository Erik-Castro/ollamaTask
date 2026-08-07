export interface FileWriteResult {
  path: string;
  bytesWritten: number;
}

/**
 * Escreve `content` em um arquivo local sob demanda (cria/sobrescreve).
 * Retorna um resultado estruturado: { path, bytesWritten }.
 */
export const FileWrite = async (
  path: string,
  content: string,
): Promise<FileWriteResult> => {
  await Deno.writeTextFile(path, content);
  return { path, bytesWritten: content.length };
};
