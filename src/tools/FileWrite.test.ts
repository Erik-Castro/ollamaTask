import { assertEquals } from "@std/assert";
import { FileWrite, FileWriteUnconditional } from "./FileWrite.ts";
import { FileRead } from "./FileRead.ts";
import { FsError, resetFileObservation } from "./file-core.ts";

let dir = "";

async function setup(): Promise<void> {
  resetFileObservation();
  dir = await Deno.makeTempDir({ prefix: "ollamatask-write-" });
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

Deno.test("FileWrite creates an unobserved file", async () => {
  await setup();
  try {
    const result = await FileWrite(path("a.txt"), "hello");
    assertEquals(result.operation, "create");
    assertEquals(result.before, null);
    assertEquals(result.after, "hello");
    assertEquals(result.bytesWritten, 5);
    assertEquals(await Deno.readTextFile(path("a.txt")), "hello");
  } finally {
    await teardown();
  }
});

Deno.test("FileWrite overwrites after a read (update)", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "old\n");
    await FileRead(path("a.txt"));
    const result = await FileWrite(path("a.txt"), "new");
    assertEquals(result.operation, "update");
    assertEquals(result.before, "old\n");
    assertEquals(result.after, "new");
    assertEquals(await Deno.readTextFile(path("a.txt")), "new");
  } finally {
    await teardown();
  }
});

Deno.test("FileWrite refuses to overwrite an unread file (FS_NOT_OBSERVED)", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "existing");
    await rejectsFsCode(
      () => FileWrite(path("a.txt"), "new"),
      "FS_NOT_OBSERVED",
    );
  } finally {
    await teardown();
  }
});

Deno.test("FileWrite on a read-then-externally-changed file is stale (FS_STALE_VERSION)", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "abc");
    await FileRead(path("a.txt"));
    await Deno.writeTextFile(path("a.txt"), "abcde");
    await rejectsFsCode(
      () => FileWrite(path("a.txt"), "new"),
      "FS_STALE_VERSION",
    );
  } finally {
    await teardown();
  }
});

Deno.test("FileWrite serializes chained writes on the same path", async () => {
  await setup();
  try {
    const first = FileWrite(path("a.txt"), "first");
    const second = FileWrite(path("a.txt"), "second");
    await Promise.all([first, second]);
    assertEquals((await first).operation, "create");
    assertEquals((await second).operation, "update");
    assertEquals(
      (await Deno.readTextFile(path("a.txt"))).length > 0,
      true,
    );
  } finally {
    await teardown();
  }
});

Deno.test("FileWrite cleans up its staging directory", async () => {
  await setup();
  try {
    await FileWrite(path("a.txt"), "x");
    const entries = Array.from(Deno.readDirSync(dir));
    assertEquals(entries.length, 1);
    assertEquals(entries[0].name, "a.txt");
  } finally {
    await teardown();
  }
});

Deno.test("FileWrite preserves the existing file mode", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "old");
    await Deno.chmod(path("a.txt"), 0o600);
    await FileRead(path("a.txt"));
    await FileWrite(path("a.txt"), "new");
    const mode = (await Deno.stat(path("a.txt"))).mode ?? 0;
    assertEquals(mode & 0o777, 0o600);
  } finally {
    await teardown();
  }
});

Deno.test("FileWriteUnconditional overwrites without a read", async () => {
  await setup();
  try {
    await Deno.writeTextFile(path("a.txt"), "old");
    const result = await FileWriteUnconditional(path("a.txt"), "new");
    assertEquals(result.operation, "update");
    assertEquals(await Deno.readTextFile(path("a.txt")), "new");
  } finally {
    await teardown();
  }
});
