import { assertEquals } from "@std/assert";
import { FileRead, renderReadOutput } from "./FileRead.ts";
import { FsError } from "./file-core.ts";

async function rejectsFsCode(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assertEquals(
      error instanceof FsError,
      true,
      `expected FsError, got ${String(error)}`,
    );
    assertEquals((error as FsError).code, code);
    return;
  }
  throw new Error(`expected FsError(${code}) but call did not reject`);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "ollamatask-read-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("FileRead reads a whole small file window", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/a.txt`;
    await Deno.writeTextFile(path, "one\ntwo\nthree\nfour\n");
    const result = await FileRead(path);
    assertEquals(result.lines, [
      { number: 1, text: "one" },
      { number: 2, text: "two" },
      { number: 3, text: "three" },
      { number: 4, text: "four" },
    ]);
    assertEquals(result.totalLines, 4);
    assertEquals(result.truncated, false);
  });
});

Deno.test("FileRead paginates with offset/limit", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/a.txt`;
    await Deno.writeTextFile(
      path,
      Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n") + "\n",
    );
    const result = await FileRead(path, { offset: 3, limit: 2 });
    assertEquals(result.lines, [
      { number: 3, text: "l2" },
      { number: 4, text: "l3" },
    ]);
    assertEquals(result.truncated, true);
  });
});

Deno.test("FileRead offset beyond EOF rejects FS_NOT_FOUND", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/a.txt`;
    await Deno.writeTextFile(path, "a\nb\nc\n");
    await rejectsFsCode(() => FileRead(path, { offset: 10 }), "FS_NOT_FOUND");
  });
});

Deno.test("FileRead caps overlong lines", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/a.txt`;
    await Deno.writeTextFile(path, "abcdefghij\n");
    const result = await FileRead(path, { maxLineLength: 3 });
    assertEquals(result.lines, [{ number: 1, text: "abc… (truncated)" }]);
  });
});

Deno.test("FileRead handles empty files", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/a.txt`;
    await Deno.writeTextFile(path, "");
    const result = await FileRead(path);
    assertEquals(result.lines, []);
    assertEquals(result.totalLines, 0);
  });
});

Deno.test("FileRead truncates by maxBytes", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/a.txt`;
    await Deno.writeTextFile(
      path,
      Array.from({ length: 50 }, () => "hello world").join("\n") + "\n",
    );
    const result = await FileRead(path, { maxBytes: 16 });
    assertEquals(result.truncated, true);
    assertEquals(result.lines.length, 1);
  });
});

Deno.test("FileRead rejects binary (NUL) content", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/a.txt`;
    await Deno.writeFile(path, new TextEncoder().encode("text\u0000bin"));
    await rejectsFsCode(() => FileRead(path), "FS_NOT_TEXT");
  });
});

Deno.test("FileRead rejects invalid UTF-8", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/a.txt`;
    await Deno.writeFile(path, new Uint8Array([0xff, 0xfe, 0x00, 0x41]));
    await rejectsFsCode(() => FileRead(path), "FS_NOT_TEXT");
  });
});

Deno.test("FileRead missing file rejects FS_NOT_FOUND", async () => {
  await rejectsFsCode(
    () => FileRead("/nonexistent-ollamatask-xyz.txt"),
    "FS_NOT_FOUND",
  );
});

Deno.test("FileRead envelopes the window for the model", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/a.txt`;
    await Deno.writeTextFile(path, "one\ntwo\n");
    const result = await FileRead(path);
    const envelope = renderReadOutput(result);
    assertEquals(envelope.includes(`<path>${path}</path>`), true);
    assertEquals(envelope.includes("<type>file</type>"), true);
    assertEquals(envelope.includes("1\tone"), true);
    assertEquals(envelope.includes("(End of file, total 2 lines)"), true);
  });
});
