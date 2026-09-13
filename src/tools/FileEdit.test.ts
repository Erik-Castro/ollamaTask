import { assertEquals } from "@std/assert";
import { FileEdit, FileEditUnconditional } from "./FileEdit.ts";
import { FileRead } from "./FileRead.ts";
import { FsError, resetFileObservation } from "./file-core.ts";

let dir = "";

async function setup(): Promise<void> {
  resetFileObservation();
  dir = await Deno.makeTempDir({ prefix: "ollamatask-edit-" });
}

async function teardown(): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

function path(name: string): string {
  return `${dir}/${name}`;
}

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

Deno.test("FileEdit replaces a unique literal", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "hello world\n");
    await FileRead(path("a.txt"));
    const result = await FileEdit(path("a.txt"), "world", "deno");
    assertEquals(result.replacements, 1);
    assertEquals(result.before, "hello world\n");
    assertEquals(result.after, "hello deno\n");
    assertEquals(await Deno.readTextFile(path("a.txt")), "hello deno\n");
  } finally {
    await teardown();
  }
});

Deno.test("FileEdit requires a unique match by default", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "aa\n");
    await FileRead(path("a.txt"));
    await rejectsFsCode(
      () => FileEdit(path("a.txt"), "a", "x"),
      "FS_AMBIGUOUS_EDIT",
    );
  } finally {
    await teardown();
  }
});

Deno.test("FileEdit replaceAll replaces every occurrence", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "aa\n");
    await FileRead(path("a.txt"));
    const result = await FileEdit(path("a.txt"), "a", "x", {
      replaceAll: true,
    });
    assertEquals(result.replacements, 2);
    assertEquals(await Deno.readTextFile(path("a.txt")), "xx\n");
  } finally {
    await teardown();
  }
});

Deno.test("FileEdit not found rejects FS_EDIT_NOT_FOUND", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "abc\n");
    await FileRead(path("a.txt"));
    await rejectsFsCode(
      () => FileEdit(path("a.txt"), "zzz", "x"),
      "FS_EDIT_NOT_FOUND",
    );
  } finally {
    await teardown();
  }
});

Deno.test("FileEdit equal pair rejects FS_EDIT_EQUAL", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "abc\n");
    await FileRead(path("a.txt"));
    await rejectsFsCode(
      () => FileEdit(path("a.txt"), "abc", "abc"),
      "FS_EDIT_EQUAL",
    );
  } finally {
    await teardown();
  }
});

Deno.test("FileEdit normalizes CRLF and restores it on write-back", async () => {
  await setup();
  try {
    const crlf = "one\r\ntwo\r\n";
    await Deno.writeTextFile(path("a.txt"), crlf);
    await FileRead(path("a.txt"));
    await FileEdit(path("a.txt"), "two", "three");
    assertEquals(await Deno.readTextFile(path("a.txt")), "one\r\nthree\r\n");
  } finally {
    await teardown();
  }
});

Deno.test("FileEdit without a prior read rejects FS_NOT_OBSERVED", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "abc\n");
    await rejectsFsCode(
      () => FileEdit(path("a.txt"), "abc", "xyz"),
      "FS_NOT_OBSERVED",
    );
  } finally {
    await teardown();
  }
});

Deno.test("FileEdit on a read-then-externally-changed file is stale", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "abc\n");
    await FileRead(path("a.txt"));
    await Deno.writeTextFile(path("a.txt"), "abcde\n");
    await rejectsFsCode(
      () => FileEdit(path("a.txt"), "abcde", "xyz"),
      "FS_STALE_VERSION",
    );
  } finally {
    await teardown();
  }
});

Deno.test("FileEdit on a missing file rejects FS_NOT_FOUND", async () => {
  await setup();
  try {
    await rejectsFsCode(
      () => FileEdit(path("a.txt"), "abc", "xyz"),
      "FS_NOT_FOUND",
    );
  } finally {
    await teardown();
  }
});

Deno.test("FileEdit re-observes the file so a second edit works", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "one two three\n");
    await FileRead(path("a.txt"));
    await FileEdit(path("a.txt"), "two", "2");
    await FileEdit(path("a.txt"), "three", "3");
    assertEquals(await Deno.readTextFile(path("a.txt")), "one 2 3\n");
  } finally {
    await teardown();
  }
});

Deno.test("FileEditUnconditional edits without a prior read", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "abc\n");
    const result = await FileEditUnconditional(path("a.txt"), "abc", "xyz");
    assertEquals(result.replacements, 1);
    assertEquals(await Deno.readTextFile(path("a.txt")), "xyz\n");
  } finally {
    await teardown();
  }
});
