/**
 * Infra de ambiente do harness com capacidades nativas do Deno: workspace
 * scratch por execução (`Deno.makeTempDir` — "mktemp"), locks exclusivos de
 * arquivo (`Deno.open({ lock:true })` — flock) e escrita de run log seriada.
 *
 * Objetivo: o melhor aproveitamento do runtime — artefatos temporários em
 * diretório isolado com permissões restritivas (`0o700`), e escrita de log
 * determinística mesmo com execução concorrente de ferramentas.
 *
 * Nesta seção, a palavra "lock" precisa de uma nota de honestidade técnica:
 * - `Deno.flock`/`Deno.flockSync` **não existem**; o flock é pedido via
 *   `Deno.open(path, { lock: true })` e liberado no `close()` (no Termux
 *   `unlockSync` não é suportado — fechar o handle é a forma portável).
 * - **Validado por probe no Termux (Deno 2.9.5)**: `lock: true` **NÃO exclui**
 *   uma segunda abertura do mesmo arquivo dentro do mesmo processo — o pico de
 *   escritores num `Promise.all` de 3 foi 3, e a segunda `open` passou em 0ms.
 *   O flock é *advisory* e nesse runtime best-effort entre handles do mesmo
 *   processo. **A ordem determinística do run log não vem do flock** — vem do
 *   harness: `react.ts` §C aguarda (`await`) cada `logExecution` na passada
 *   sequencial, e o batch paralelo apenas cacheia resultados e os reaplica em
 *   ordem. O flock é uma defesa a mais (entre processos/terminais), não o
 *   mecanismo de serialização.
 * - Em contraste, `Deno.makeTempDir({ mode: 0o700 })` **é** respeitado — o
 *   diretório nasce com permissão restrita (probe: stat mode 0o700).
 *
 * Notas de plataforma (validadas em Deno 2.9.5 + probe de runtime):
 * - `Deno.flock`/`Deno.flockSync` **não existem**. O lock é pedido via
 *   `Deno.open(path, { lock: true })` e liberado no `close()` (no Termux
 *   `unlockSync` não é suportado — fechar o handle é a forma portável).
 * - **Atenção (probe)**: neste runtime o `lock: true` **não exclui** uma
 *   segunda abertura do mesmo arquivo **dentro do mesmo processo** (pico de
 *   escritores = 3, não 1). O flock é *advisory* e best-effort — serve como
 *   defesa entre processos/instâncias, **não** como serializador no loop. A
 *   ordem determinística do run log vem de o harness `await` cada escrita em
 *   passada sequencial (`react.ts` §C), **não** do flock.
 * - `Deno.makeTempDir({ mode })` é respeitado; `Deno.umask()` é get/set.
 * - Módulos builtin `node:` funcionam onde mais ergonômicos: `node:path`
 *   para montar caminhos do workspace e `node:fs` para garantir o baseDir.
 *
 * @module env
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Diretório temporário do sistema (honra TMPDIR/TEMP/TMP do ambiente). */
function systemTempDir(): string {
  return Deno.env.get("TMPDIR") ??
    Deno.env.get("TEMP") ??
    Deno.env.get("TMP") ??
    "/tmp";
}

/**
 * Tipos do Deno 2.9.5 ainda não declaram `mode` (makeTempDir) nem `lock`
 * (open) — mas o **runtime** aceita ambos sem flag unstable (validado por
 * probe). Estas interseções documentam a lacuna e mantêm o `deno check` feliz.
 */
type MakeTempOptionsWithMode = Deno.MakeTempOptions & { mode?: number };
type OpenOptionsWithLock = Deno.OpenOptions & { lock?: boolean };

/** Opções de {@link createWorkspace}. */
export interface WorkspaceOptions {
  /** Prefixo do diretório temporário (default: `"agentcore-"`). */
  prefix?: string;
  /** Diretório base do workspace (default: temp do sistema). */
  dir?: string;
}

/**
 * Workspace de uma execução: diretório isolado com permissões restritas.
 *
 * `file(name)` monta caminhos dentro do workspace via `node:path`. Para
 * workspaces efêmeros, `cleanup()` remove a árvore inteira (best-effort).
 */
export interface Workspace {
  /** Caminho absoluto do workspace. */
  path: string;
  /** Monta o caminho de um arquivo dentro do workspace. */
  file(name: string): string;
  /** Remove a árvore do workspace (best-effort; ignora falhas). */
  cleanup(): Promise<void>;
}

function makeWorkspace(path: string): Workspace {
  return {
    path,
    file: (name: string) => join(path, name),
    async cleanup() {
      try {
        await Deno.remove(path, { recursive: true });
      } catch {
        // best-effort: árvore já removida ou sem permissão
      }
    },
  };
}

/**
 * Cria um workspace efêmero no diretório temporário do sistema ("mktemp").
 *
 * O diretório nasce com modo `0o700` (respeitado pelo `Deno.makeTempDir`,
 * reforçado pelo umask do processo): nada criado pelo agente fica legível
 * por outros usuários. Use `cleanup()` ao terminar — não vaza lixo no FS.
 *
 * @example
 * ```ts
 * const ws = await createWorkspace({ prefix: "run-" });
 * const log = ws.file("run.log");
 * await Deno.writeTextFile(log, "linha");
 * await ws.cleanup();
 * ```
 */
export async function createWorkspace(
  options: WorkspaceOptions = {},
): Promise<Workspace> {
  const makeTempOptions: MakeTempOptionsWithMode = {
    prefix: options.prefix ?? "agentcore-",
    dir: options.dir ?? systemTempDir(),
    mode: 0o700,
  };
  const path = await Deno.makeTempDir(makeTempOptions);
  return makeWorkspace(path);
}

/** Opções de {@link createRunWorkspace}. */
export interface RunWorkspaceOptions {
  /** Diretório base dos artefatos (criado recursivamente se faltar). */
  baseDir: string;
  /** Prefixo do subdiretório de cada execução (default: `"run-"`). */
  prefix?: string;
}

/**
 * Cria o workspace de uma execução **persistente** dentro de `baseDir`.
 *
 * Garante `baseDir` (via `node:fs` `mkdirSync` com modo `0o700`) e cria um
 * subdiretório único por execução (`makeTempDir` com `mode: 0o700`). Usado
 * pelo harness quando `ReActOptions.workspaceDir` está ativo — os artefatos
 * ficam no disco para inspeção (não é auto-limpo).
 *
 * @example
 * ```ts
 * const run = await createRunWorkspace({ baseDir: ".agentcore" });
 * console.log(run.path); // .agentcore/run-xxxxxx
 * ```
 */
export async function createRunWorkspace(
  options: RunWorkspaceOptions,
): Promise<Workspace> {
  if (!existsSync(options.baseDir)) {
    mkdirSync(options.baseDir, { recursive: true, mode: 0o700 });
  }
  const makeTempOptions: MakeTempOptionsWithMode = {
    prefix: options.prefix ?? "run-",
    dir: options.baseDir,
    mode: 0o700,
  };
  const path = await Deno.makeTempDir(makeTempOptions);
  return makeWorkspace(path);
}

/**
 * Executa `fn` segurando um **flock exclusivo** no arquivo `path`.
 *
 * O lock é adquirido abrindo o arquivo com `Deno.open({ read:true,
 * write:true, lock:true })` (cria se faltar) e liberado no `close()` — em
 * Deno 2.9.x não há `Deno.flock`, e `unlockSync` pode ser não suportado em
 * plataformas como o Termux; fechar o handle é a forma de liberar.
 *
 * @param path Caminho do arquivo (criado se não existir).
 * @param fn Trabalho a executar sob o lock (escrita/append, por exemplo).
 * @example
 * ```ts
 * await withFileLock(log, async () => {
 *   await Deno.writeTextFile(log, "linha\n", { append: true });
 * });
 * ```
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const openOptions: OpenOptionsWithLock = {
    create: true,
    read: true,
    write: true,
    lock: true,
  };
  const file = await Deno.open(path, openOptions);
  try {
    return await fn();
  } finally {
    file.close();
  }
}

/**
 * Anexa uma linha (terminada em `\n`) a um arquivo **sob flock**.
 *
 * Usado pelo run log do harness: mesmo com ferramentas executando em
 * paralelo, cada anexação é serializada — a ordem da escrita segue a ordem
 * das chamadas quando o consumidor aguarda cada anexação (como o loop faz).
 *
 * @example
 * ```ts
 * await appendLineLocked(log, JSON.stringify({ tool: "uppercase", ok: true }));
 * ```
 */
export async function appendLineLocked(
  path: string,
  line: string,
): Promise<void> {
  const text = line.endsWith("\n") ? line : `${line}\n`;
  await withFileLock(
    path,
    () => Deno.writeTextFile(path, text, { append: true }),
  );
}
