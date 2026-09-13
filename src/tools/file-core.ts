import { dirname, join, resolve } from "node:path";

// ── Errors ────────────────────────────────────────────────────────────────────

export type FsCode =
  | "FS_NOT_FOUND"
  | "FS_NOT_REGULAR_FILE"
  | "FS_NOT_TEXT"
  | "FS_NOT_OBSERVED"
  | "FS_STALE_VERSION"
  | "FS_EDIT_NOT_FOUND"
  | "FS_AMBIGUOUS_EDIT"
  | "FS_EDIT_EQUAL";

export class FsError extends Error {
  readonly code: FsCode;

  constructor(code: FsCode, message: string) {
    super(message);
    this.name = "FsError";
    this.code = code;
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_READ_LIMIT = 2000;
export const MAX_LINE_LENGTH = 2000;
export const MAX_READ_BYTES = 50 * 1024;
export const WRITE_BEFORE_CAP_BYTES = 10 * 1024 * 1024;

// ── Observed-state (read-before-write policy) ─────────────────────────────────

interface ObservedState {
  kind: "present" | "absent";
  version?: string;
}

export function resolvePath(path: string): string {
  return resolve(path);
}

const observedByPath = new Map<string, ObservedState>();
const locksByPath = new Map<string, Promise<unknown>>();

function fileVersion(stat: Deno.FileInfo): string {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtime?.getTime() ?? 0,
    stat.ctime?.getTime() ?? 0,
  ].join(":");
}

function recordObserved(key: string, state: ObservedState): void {
  observedByPath.set(key, state);
}

export function recordObservedPresent(key: string, stat: Deno.FileInfo): void {
  recordObserved(key, { kind: "present", version: fileVersion(stat) });
}

export function recordObservedAbsent(key: string): void {
  recordObserved(key, { kind: "absent" });
}

export function resetFileObservation(): void {
  observedByPath.clear();
}

export function lockPath<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolvePath(path);
  const previous = locksByPath.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  locksByPath.set(key, next as Promise<unknown>);
  void next.then(
    () => {
      if (locksByPath.get(key) === next) locksByPath.delete(key);
    },
    () => {
      if (locksByPath.get(key) === next) locksByPath.delete(key);
    },
  );
  return next;
}

export function guardForWrite(
  path: string,
  statNow: Deno.FileInfo | null,
): void {
  const observed = observedByPath.get(resolvePath(path));

  if (observed === undefined) {
    if (statNow !== null) {
      throw new FsError(
        "FS_NOT_OBSERVED",
        `cannot modify ${path}: file has not been read yet — read the file, then retry`,
      );
    }
    return;
  }

  if (observed.kind === "absent") {
    if (statNow !== null) {
      throw new FsError(
        "FS_STALE_VERSION",
        `cannot modify ${path}: file changed since it was last read — re-read the file, then retry`,
      );
    }
    return;
  }

  if (statNow === null || fileVersion(statNow) !== observed.version) {
    throw new FsError(
      "FS_STALE_VERSION",
      `cannot modify ${path}: file changed since it was last read — re-read the file, then retry`,
    );
  }
}

export function guardForEdit(
  path: string,
  statNow: Deno.FileInfo | null,
): void {
  if (statNow === null) {
    throw new FsError("FS_NOT_FOUND", `file not found: ${path}`);
  }

  const observed = observedByPath.get(resolvePath(path));

  if (observed === undefined || observed.kind !== "present") {
    throw new FsError(
      "FS_NOT_OBSERVED",
      `cannot modify ${path}: file has not been read yet — read the file, then retry`,
    );
  }

  if (fileVersion(statNow) !== observed.version) {
    throw new FsError(
      "FS_STALE_VERSION",
      `cannot modify ${path}: file changed since it was last read — re-read the file, then retry`,
    );
  }
}

// ── Line ending helpers ───────────────────────────────────────────────────────

export function normalizeEol(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

export function restoreEol(text: string, original: string): string {
  if (original.includes("\r\n")) return text.replace(/\n/g, "\r\n");
  if (/\r(?!\n)/.test(original)) return text.replace(/\n/g, "\r");
  return text;
}

// ── Literal edit ──────────────────────────────────────────────────────────────

export interface LiteralEditResult {
  replacements: number;
  content: string;
}

export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): LiteralEditResult {
  if (oldString === newString) {
    throw new FsError("FS_EDIT_EQUAL", "old_string and new_string must differ");
  }

  const haystack = normalizeEol(content);
  const needle = normalizeEol(oldString);
  const replacement = normalizeEol(newString);

  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }

  if (count === 0) {
    throw new FsError(
      "FS_EDIT_NOT_FOUND",
      `old_string was not found in the file`,
    );
  }

  if (count > 1 && !replaceAll) {
    throw new FsError(
      "FS_AMBIGUOUS_EDIT",
      `old_string matched ${count} instances — provide a more unique old_string or use replace_all`,
    );
  }

  const result = replaceAll
    ? haystack.split(needle).join(replacement)
    : haystack.replace(needle, replacement);

  return { replacements: count, content: result };
}

// ── Text decoding ─────────────────────────────────────────────────────────────

function decodeFatal(text: string): void {
  if (text.includes("\u0000")) {
    throw new FsError("FS_NOT_TEXT", `file is not a text file`);
  }
}

export function decodeUtf8Strict(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}

export async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

export async function readTextCapped(
  path: string,
  capBytes: number,
): Promise<{ text: string; capped: boolean }> {
  const file = await Deno.open(path, { read: true });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const chunkSize = 64 * 1024;
    const chunk = new Uint8Array(chunkSize);
    let text = "";
    let fed = 0;
    let capped = false;

    while (fed <= capBytes) {
      const n = await file.read(chunk);
      if (n === null) break;
      if (n === 0) continue;
      fed += n;
      const decoded = decoder.decode(chunk.subarray(0, n), { stream: true });
      decodeFatal(decoded);
      text += decoded;
      if (fed >= capBytes) {
        capped = true;
        break;
      }
    }

    if (!capped) {
      const tail = decoder.decode();
      decodeFatal(tail);
      text += tail;
    }

    return { text, capped };
  } catch (error) {
    if (error instanceof FsError) throw error;
    throw new FsError("FS_NOT_TEXT", `file is not a valid UTF-8 text file`);
  } finally {
    file.close();
  }
}

// ── Atomic write ──────────────────────────────────────────────────────────────

export interface AtomicWriteResult {
  path: string;
  operation: "create" | "update";
  before: string | null;
  after: string;
  bytesWritten: number;
}

export async function writeFileAtomic(
  path: string,
  content: string,
): Promise<AtomicWriteResult> {
  const stat = await lstatOrNull(path);

  if (stat !== null && stat.isDirectory) {
    throw new FsError("FS_NOT_REGULAR_FILE", `${path} is not a regular file`);
  }

  const operation: "create" | "update" = stat === null ? "create" : "update";

  let before: string | null = null;
  if (stat !== null) {
    const { text, capped } = await readTextCapped(path, WRITE_BEFORE_CAP_BYTES);
    before = capped ? null : normalizeEol(text);
  }

  const parent = dirname(resolvePath(path)) || ".";
  const base = path.split("/").pop() ?? "file";
  const tmpId = `${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  const tmpDir = join(parent, `.${base}.${tmpId}.tmpdir`);
  const staged = join(tmpDir, "content");

  await Deno.mkdir(tmpDir, { mode: 0o700 });

  const file = await Deno.open(staged, {
    write: true,
    createNew: true,
    mode: 0o600,
  });

  const bytes = new TextEncoder().encode(content);
  try {
    let written = 0;
    while (written < bytes.length) {
      written += await file.write(bytes.subarray(written));
    }
    await file.sync();
  } finally {
    file.close();
  }

  if (stat?.mode !== null && stat?.mode !== undefined) {
    const mode = stat.mode & 0o777;
    if (mode) await Deno.chmod(staged, mode);
  }

  try {
    await Deno.rename(staged, path);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }

  const freshStat = await lstatOrNull(path);
  if (freshStat !== null) {
    recordObservedPresent(resolvePath(path), freshStat);
  }

  return {
    path,
    operation,
    before,
    after: normalizeEol(content),
    bytesWritten: bytes.length,
  };
}

// ── Read window ───────────────────────────────────────────────────────────────

export interface FileLine {
  number: number;
  text: string;
}

export interface ReadWindowResult {
  path: string;
  offset: number;
  lines: FileLine[];
  totalLines: number;
  truncated: boolean;
}

export interface FileReadOptions {
  offset?: number;
  limit?: number;
  maxLineLength?: number;
  maxBytes?: number;
}

const OVERLONG_PENDING_LIMIT = 12 * 1024;

function capLine(text: string, maxLineLength: number): string {
  return text.length > maxLineLength
    ? text.slice(0, maxLineLength) + "… (truncated)"
    : text;
}

export async function readWindow(
  path: string,
  options: FileReadOptions = {},
): Promise<ReadWindowResult> {
  const offset = Math.max(1, Math.floor(options.offset ?? 1));
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_READ_LIMIT));
  const maxLineLength = Math.max(
    1,
    Math.floor(options.maxLineLength ?? MAX_LINE_LENGTH),
  );
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? MAX_READ_BYTES));

  const stat = await lstatOrNull(path);
  if (stat === null) {
    throw new FsError("FS_NOT_FOUND", `file not found: ${path}`);
  }
  if (!stat.isFile) {
    throw new FsError("FS_NOT_REGULAR_FILE", `${path} is not a regular file`);
  }

  const key = resolvePath(path);

  if (stat.size === 0) {
    recordObservedPresent(key, stat);
    return { path, offset, lines: [], totalLines: 0, truncated: false };
  }

  const file = await Deno.open(path, { read: true });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const chunkSize = 64 * 1024;
    const chunk = new Uint8Array(chunkSize);

    let pending = "";
    let lineCount = 0;
    let windowsBytes = 0;
    let readToEof = true;
    const lines: FileLine[] = [];

    const consumeLine = (raw: string): void => {
      lineCount++;
      if (lineCount < offset) return;
      if (lines.length >= limit) return;
      const text = capLine(raw, maxLineLength);
      const lineBytes = new TextEncoder().encode(text).length + 1;
      if (windowsBytes + lineBytes > maxBytes) return;
      windowsBytes += lineBytes;
      lines.push({ number: lineCount, text });
    };

    for (;;) {
      const n = await file.read(chunk);
      if (n === null) break;

      let decoded: string;
      try {
        decoded = decoder.decode(chunk.subarray(0, n), { stream: true });
      } catch {
        throw new FsError(
          "FS_NOT_TEXT",
          `${path} is not a valid UTF-8 text file`,
        );
      }

      if (decoded.includes("\u0000")) {
        throw new FsError("FS_NOT_TEXT", `${path} is not a text file`);
      }

      pending += decoded;

      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        consumeLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }

      if (pending.length > OVERLONG_PENDING_LIMIT) {
        pending = pending.slice(pending.length - OVERLONG_PENDING_LIMIT);
      }

      if (lines.length >= limit) {
        // Window is full; more content may still follow.
        readToEof = false;
        break;
      }
    }

    if (readToEof) {
      try {
        const tail = decoder.decode();
        if (tail.length > 0) pending += tail;
      } catch {
        throw new FsError(
          "FS_NOT_TEXT",
          `${path} is not a valid UTF-8 text file`,
        );
      }
      if (pending.length > 0) consumeLine(pending);
    }

    if (readToEof && offset > lineCount) {
      throw new FsError("FS_NOT_FOUND", `file not found: ${path}`);
    }

    const lastReturned = lines.length > 0
      ? lines[lines.length - 1].number
      : offset - 1;
    const truncated = !readToEof || lineCount > lastReturned;

    recordObservedPresent(key, stat);

    return {
      path,
      offset,
      lines,
      totalLines: lineCount,
      truncated,
    };
  } finally {
    file.close();
  }
}

// ── Envelope rendering (model-facing) ─────────────────────────────────────────

export function formatReadOutput(result: ReadWindowResult): string {
  const body = result.lines.map((line) => `${line.number}\t${line.text}`).join(
    "\n",
  );

  const first = result.lines.length > 0
    ? result.lines[0].number
    : result.offset;
  const last = result.lines.length > 0
    ? result.lines[result.lines.length - 1].number
    : result.offset - 1;

  const footer = result.truncated
    ? `(Showing lines ${first}-${last} of ~${result.totalLines}. Use offset=${
      last + 1
    } to continue.)`
    : `(End of file, total ${result.totalLines} lines)`;

  return [
    `<path>${result.path}</path>`,
    `<type>file</type>`,
    `<content>`,
    body,
    `</content>`,
    footer,
  ].join("\n");
}
