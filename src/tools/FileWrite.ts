import {
  guardForWrite,
  lockPath,
  lstatOrNull,
  writeFileAtomic,
} from "./file-core.ts";

export interface FileWriteResult {
  path: string;
  operation: "create" | "update";
  before: string | null;
  after: string;
  bytesWritten: number;
}

/**
 * Escreve um arquivo de texto de forma atômica (temp + rename), espelhando a
 * tool `write` do deepseek-harness. Retorna { path, operation, before, after,
 * bytesWritten }, com before/after LF-normalizados (base para diff; `before`
 * é null para arquivos acima do cap de 10 MiB).
 *
 * Read-before-write: exige que o path tenha sido observado com `FileRead`
 * (presente@versão ou ausente). Desobservado + existente → FS_NOT_OBSERVED;
 * observado mas com versão alterada desde a última leitura →
 * FS_STALE_VERSION. Use `FileWriteUnconditional` para pular a guarda.
 */
export const FileWrite = (
  path: string,
  content: string,
): Promise<FileWriteResult> => {
  return lockPath(path, async () => {
    const statNow = await lstatOrNull(path);
    guardForWrite(path, statNow);
    return await writeFileAtomic(path, content);
  });
};

/**
 * Mesma atomicidade de `FileWrite`, sem a política read-before-write.
 * Indicado para scripts que criam/sobrescrevem sem leitura prévia.
 */
export const FileWriteUnconditional = (
  path: string,
  content: string,
): Promise<FileWriteResult> => writeFileAtomic(path, content);
