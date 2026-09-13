/**
 * Testes da infra de ambiente (src/env.ts) — FS real, offline, sem rede.
 *
 * Premissa validada por probe neste runtime (Deno 2.9.5 + Termux):
 * **`Deno.open({ lock: true })` NÃO serializa** duas aberturas do mesmo
 * arquivo dentro do **mesmo processo** — a 2ª `open` não bloqueia (pico de
 * escritores concorrentes = 3, não 1). O flock é *advisory* / best-effort
 * entre **processos**; **dentro** do harness a ordem determinística do run
 * log vem do loop que `await` cada `appendLineLocked` em passada sequencial
 * (`react.ts` §C — com batch paralelo, os resultados são aplicados em
 * passada sequencial por `call_id`, preservando a ordem). Estes testes
 * verificam as garantias **portáveis**: criação efêmera 0o700, cleanup
 * best-effort, append em ordem quando chamado em sequência (que é o contrato
 * que o harness realmente usa).
 */
import { join } from "node:path";
import { assertEquals } from "@std/assert";
import {
  appendLineLocked,
  createRunWorkspace,
  createWorkspace,
  withFileLock,
} from "./env.ts";

const rw = { permissions: { read: true, write: true, env: true } };

Deno.test(
  "env: createWorkspace cria dir 0o700 efêmero; cleanup remove a árvore",
  rw,
  async () => {
    const ws = await createWorkspace({ prefix: "wtest-" });
    try {
      const info = Deno.statSync(ws.path);
      assertEquals(info.isDirectory, true);
      assertEquals((info.mode! & 0o777) >>> 0, 0o700);
      const file = join(ws.path, "x.txt");
      await Deno.writeTextFile(file, "oi");
      assertEquals(await Deno.readTextFile(file), "oi");
      assertEquals(ws.file("y.txt").startsWith(ws.path), true);
    } finally {
      await ws.cleanup();
    }
    await assertEquals(
      await Deno.lstat(ws.path).then(() => true).catch(() => false),
      false,
    );
  },
);

Deno.test(
  "env: createRunWorkspace garante baseDir e cria subdir run 0o700",
  rw,
  async () => {
    const base = await createWorkspace({ prefix: "wbase-" });
    try {
      const ws = await createRunWorkspace({
        baseDir: base.path,
        prefix: "run-",
      });
      try {
        const info = Deno.statSync(ws.path);
        assertEquals(info.isDirectory, true);
        assertEquals((info.mode! & 0o777) >>> 0, 0o700);
        assertEquals(ws.path.startsWith(base.path), true);
        assertEquals(ws.path.includes("run-"), true);
      } finally {
        await ws.cleanup();
      }
    } finally {
      await base.cleanup();
    }
  },
);

Deno.test(
  "env: withFileLock executa o corpo e libera o lock no close",
  rw,
  async () => {
    const ws = await createWorkspace({ prefix: "wlock-" });
    try {
      const log = ws.file("run.log");
      await Deno.writeTextFile(log, "");
      let ran = false;
      await withFileLock(log, async () => {
        ran = true;
        // segundo lock no mesmo arquivo após o primeiro: não deve lançar.
        await withFileLock(log, async () => {});
      });
      assertEquals(ran, true);
    } finally {
      await ws.cleanup();
    }
  },
);

Deno.test(
  "env: appendLineLocked em sequência preserva ordem e newline final",
  rw,
  async () => {
    const ws = await createWorkspace({ prefix: "wappend-" });
    try {
      const log = ws.file("run.log");
      await Deno.writeTextFile(log, "");
      // O harness chama em passada sequencial (await), então a ordem é o
      // contrato real — flock aqui é best-effort e não serializa no processo.
      for (const l of ["a", "b", "c"]) {
        await appendLineLocked(log, l);
      }
      const text = await Deno.readTextFile(log);
      assertEquals(text, "a\nb\nc\n");
    } finally {
      await ws.cleanup();
    }
  },
);
