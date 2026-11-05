import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PASSTHROUGH_ENV = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_PLUGINS_DIR',
  'CLAUDE_PLUGINS_REF',
  // Where the image's build tools live (see the Dockerfile). Without them rustup finds no toolchain.
  'RUSTUP_HOME',
  'CARGO_HOME',
  'PLAYWRIGHT_BROWSERS_PATH',
  'NODE_PATH',
  'PIP_BREAK_SYSTEM_PACKAGES',
];

/** The environment every child process gets: no credentials. Callers add the one credential a child needs. */
export function baseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENV) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

const KILL_GRACE_MS = 10_000;

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcOptions {
  env: Record<string, string>;
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
}

export function runProc(command: string, args: string[], options: ProcOptions): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: options.signal !== undefined,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        // The group already exited.
      }
    };
    // The harness's shells and MCP servers share its process group and would otherwise keep the pipes open.
    const cancel = (): void => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
      }, KILL_GRACE_MS);
    };
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener('abort', cancel, { once: true });
    let stdout = '';
    let stderr = '';
    const stdoutLines = createInterface({ input: child.stdout });
    const stderrLines = createInterface({ input: child.stderr });
    stdoutLines.on('line', (line) => {
      if (options.onStdoutLine) options.onStdoutLine(line);
      else stdout += `${line}\n`;
    });
    stderrLines.on('line', (line) => {
      stderr += `${line}\n`;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
      options.onStderrLine?.(line);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
    let spawnError: Error | null = null;
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', cancel);
      if (spawnError && code === null && !options.signal?.aborted) stderr += `${spawnError.message}\n`;
      resolve({ code, stdout, stderr });
    });
  });
}

export async function check(command: string, args: string[], options: ProcOptions): Promise<string> {
  const result = await runProc(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${command} ${args[0] ?? ''} failed (exit ${String(result.code)}): ${detail}`);
  }
  return result.stdout.trim();
}
