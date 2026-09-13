import {
  applyLiteralEdit,
  FsError,
  guardForEdit,
  lockPath,
  lstatOrNull,
  normalizeEol,
  readTextCapped,
  restoreEol,
  writeFileAtomic,
} from "./file-core.ts";

export interface FileEditOptions {
  replaceAll?: boolean;
}

export interface FileEditResult {
  path: string;
  before: string;
  after: string;
  replacements: number;
}

async function editFile(
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<FileEditResult> {
  const statNow = await lstatOrNull(path);
  if (statNow === null) {
    throw new FsError("FS_NOT_FOUND", `file not found: ${path}`);
  }
  if (!statNow.isFile) {
    throw new FsError("FS_NOT_REGULAR_FILE", `${path} is not a regular file`);
  }

  const original = (await readTextCapped(path, Number.MAX_SAFE_INTEGER)).text;
  const edit = applyLiteralEdit(original, oldString, newString, replaceAll);
  const written = restoreEol(edit.content, original);

  await writeFileAtomic(path, written);

  return {
    path,
    before: normalizeEol(original),
    after: normalizeEol(edit.content),
    replacements: edit.replacements,
  };
}

/**
 * Edição literal de um arquivo de texto, espelhando a tool `edit` do
 * deepseek-harness. Case-sensitive e byte-exata após normalização CRLF→LF;
 * por padrão exige match único, senão FS_AMBIGUOUS_EDIT (use replace_all).
 * O write-back restaura o estilo de fim de linha original do arquivo.
 *
 * Read-before-write: exige o path observado com `FileRead` na versão atual,
 * senão FS_NOT_OBSERVED / FS_STALE_VERSION.
 */
export const FileEdit = (
  path: string,
  oldString: string,
  newString: string,
  options: FileEditOptions = {},
): Promise<FileEditResult> => {
  const replaceAll = options.replaceAll ?? false;
  return lockPath(path, async () => {
    const statNow = await lstatOrNull(path);
    guardForEdit(path, statNow);
    return await editFile(path, oldString, newString, replaceAll);
  });
};

/**
 * Mesma edição literal, porém sem a política read-before-write.
 */
export const FileEditUnconditional = (
  path: string,
  oldString: string,
  newString: string,
  options: FileEditOptions = {},
): Promise<FileEditResult> => {
  const replaceAll = options.replaceAll ?? false;
  return lockPath(path, () => editFile(path, oldString, newString, replaceAll));
};
