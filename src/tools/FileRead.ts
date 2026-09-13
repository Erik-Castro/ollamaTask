import {
  type FileLine,
  type FileReadOptions,
  formatReadOutput,
  FsError,
  readWindow,
  recordObservedAbsent,
  resolvePath,
} from "./file-core.ts";

export interface FileReadResult {
  path: string;
  offset: number;
  lines: FileLine[];
  totalLines: number;
  truncated: boolean;
}

/**
 * Lê um arquivo de texto por janela de linhas (1-based), espelhando a tool
 * `read` do deepseek-harness. Retorna { path, offset, lines[], totalLines,
 * truncated }. Caps: limit (2000 linhas), maxLineLength (2000 chars) e
 * maxBytes (50 KiB) por janela; a leitura é por streaming, sem carregar o
 * arquivo inteiro na memória.
 *
 * Registrar a observação do arquivo (read-before-write): `file_read` grava o
 * estado observado (presente@versão ou ausente) usado pelas guards de
 * `FileWrite`/`FileEdit`.
 */
export const FileRead = async (
  path: string,
  options: FileReadOptions = {},
): Promise<FileReadResult> => {
  try {
    return await readWindow(path, options);
  } catch (error) {
    if (error instanceof FsError && error.code === "FS_NOT_FOUND") {
      recordObservedAbsent(resolvePath(path));
    }
    throw error;
  }
};

export const renderReadOutput = formatReadOutput;
