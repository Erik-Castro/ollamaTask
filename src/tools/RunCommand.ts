export interface RunCommandResult {
  command: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  allowedCommands?: string[];
}

const DEFAULT_ALLOWED_COMMANDS = [
  "git",
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "rg",
  "grep",
  "wc",
  "echo",
  "date",
  "du",
  "df",
  "find",
];

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Executa `command` com `args` (array, sem shell → sem injeção) apenas se o
 * comando estiver na whitelist. Com timeout, resultado estruturado e
 * truncamento de saída para caber no contexto do modelo.
 */
export const RunCommand = async (
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> => {
  const allowed = options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
  if (!allowed.includes(command)) {
    return {
      command,
      args,
      code: null,
      stdout: "",
      stderr: `comando "${command}" não está na whitelist`,
      timedOut: false,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const MAX_OUTPUT_CHARS = 4000;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const decode = (bytes: Uint8Array): string =>
    new TextDecoder().decode(bytes).slice(0, MAX_OUTPUT_CHARS);

  try {
    const { code, stdout, stderr } = await new Deno.Command(command, {
      args,
      cwd: options.cwd,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();

    return {
      command,
      args,
      code,
      stdout: decode(stdout),
      stderr: decode(stderr),
      timedOut,
    };
  } catch (error) {
    return {
      command,
      args,
      code: null,
      stdout: "",
      stderr: timedOut
        ? `timeout após ${timeoutMs}ms`
        : error instanceof Error
        ? error.message
        : "erro ao executar",
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
};
