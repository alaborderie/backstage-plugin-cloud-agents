import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type {
  AuthService,
  DiscoveryService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import type { ReasoningCredential } from '@alaborderie/plugin-cloud-agents-common';

const SETTINGS_HINT =
  'Add your Claude Code token (printed by `claude setup-token`) as the Claude Code credential in Cloud agents > Settings, at /cloud-agents/settings. An Anthropic API key there also works.';

const SYSTEM = `You are the reasoning model behind a Backstage chat assistant. Another model sends you one hard question with the context it gathered. Answer it thoroughly but without padding, in Markdown. Say what you are unsure of.`;

export type ReasoningResult =
  | { answer: string; model: string; credential: ReasoningCredential['kind'] }
  | { error: string; message: string };

export interface ClaudeCodeOptions {
  model: string;
  /** The `claude` executable, looked up on `PATH` when bare. */
  claudePath: string;
  timeoutMs: number;
}

type ProcessOutcome =
  | { kind: 'exited'; code: number | null; stdout: string; stderr: string }
  | { kind: 'not_started'; reason: string }
  | { kind: 'timed_out' }
  | { kind: 'aborted' };

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    input: string;
    timeoutMs: number;
    signal: AbortSignal;
  },
): Promise<ProcessOutcome> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stopped: 'timed_out' | 'aborted' | undefined;
    const stop = (why: 'timed_out' | 'aborted') => {
      stopped ??= why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timed_out'), options.timeoutMs);
    const onAbort = () => stop('aborted');
    options.signal.addEventListener('abort', onAbort, { once: true });
    const settle = (outcome: ProcessOutcome) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
    });
    // The child can exit before it reads stdin; that EPIPE is not our error.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
    child.on('error', error =>
      settle({ kind: 'not_started', reason: error.message }),
    );
    child.on('close', code =>
      settle(
        stopped ? { kind: stopped } : { kind: 'exited', code, stdout, stderr },
      ),
    );
  });
}

/** The part of `claude --print --output-format json` this plugin reads. */
interface ClaudeCodeResult {
  is_error?: boolean;
  result?: string;
  api_error_status?: number | null;
  modelUsage?: Record<string, unknown>;
}

/**
 * One prompt through the Claude Code CLI, the only client a Claude
 * subscription token may be used with. Each call gets an empty working
 * directory and its own HOME and config directory, removed afterwards, plus no
 * tools, no MCP servers, no settings files, and only the environment below, so
 * nothing of one user's call reaches another's or the backend's secrets.
 */
export async function askClaudeCode(
  options: ClaudeCodeOptions,
  oauthToken: string,
  prompt: string,
  signal: AbortSignal,
): Promise<ReasoningResult> {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-reasoning-'));
  try {
    const home = join(dir, 'home');
    const cwd = join(dir, 'work');
    await Promise.all([mkdir(home), mkdir(cwd)]);
    const outcome = await runProcess(
      options.claudePath,
      [
        '--print',
        '--output-format',
        'json',
        '--model',
        options.model,
        '--effort',
        'high',
        '--system-prompt',
        SYSTEM,
        '--tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--disable-slash-commands',
        '--permission-prompts',
        'none',
        '--no-session-persistence',
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: home,
          TMPDIR: dir,
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        input: prompt,
        timeoutMs: options.timeoutMs,
        signal,
      },
    );
    switch (outcome.kind) {
      case 'aborted':
        throw signal.reason ?? new Error('aborted');
      case 'not_started':
        return {
          error: 'claude_code_missing',
          message: `The Backstage server could not start Claude Code (${options.claudePath}): ${outcome.reason}`,
        };
      case 'timed_out':
        return {
          error: 'claude_code_timeout',
          message: `Claude Code gave no answer within ${Math.round(
            options.timeoutMs / 1000,
          )} seconds.`,
        };
      case 'exited':
        return readClaudeCodeResult(outcome, options.model);
      default:
        return outcome satisfies never;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function readClaudeCodeResult(
  outcome: { code: number | null; stdout: string; stderr: string },
  model: string,
): ReasoningResult {
  let parsed: ClaudeCodeResult;
  try {
    parsed = JSON.parse(outcome.stdout) as ClaudeCodeResult;
  } catch {
    return {
      error: 'claude_code_failed',
      message: `Claude Code exited with ${outcome.code}: ${
        outcome.stderr.trim().slice(-500) || 'no output'
      }`,
    };
  }
  if (!parsed.is_error && typeof parsed.result === 'string') {
    const models = Object.keys(parsed.modelUsage ?? {});
    return {
      answer: parsed.result,
      model: models.length ? models.join(', ') : model,
      credential: 'claude_code',
    };
  }
  const detail = parsed.result ?? 'no result';
  if (parsed.api_error_status === 401 || parsed.api_error_status === 403) {
    return {
      error: 'invalid_claude_credential',
      message: `Claude rejected the stored Claude Code token (${detail}). ${SETTINGS_HINT}`,
    };
  }
  if (parsed.api_error_status === 429) {
    return {
      error: 'rate_limited',
      message: `Claude is rate-limiting this account (${detail}); try again later.`,
    };
  }
  return {
    error: 'claude_code_error',
    message: `Claude Code failed: ${detail}`,
  };
}

async function askMessagesApi(
  apiKey: string,
  model: string,
  prompt: string,
  signal: AbortSignal,
): Promise<ReasoningResult> {
  const client = new Anthropic({ apiKey });
  try {
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal },
    );
    if (response.stop_reason === 'refusal') {
      return {
        error: 'refusal',
        message: `Claude declined to answer${
          response.stop_details?.category
            ? ` (${response.stop_details.category})`
            : ''
        }.`,
      };
    }
    const answer = response.content
      .flatMap(block => (block.type === 'text' ? [block.text] : []))
      .join('');
    return { answer, model: response.model, credential: 'api_key' };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return {
        error: 'invalid_anthropic_key',
        message: `Anthropic rejected the stored API key. ${SETTINGS_HINT}`,
      };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return {
        error: 'rate_limited',
        message: 'Anthropic rate-limited the key; try again in a minute.',
      };
    }
    if (error instanceof Anthropic.APIError) {
      return {
        error: 'anthropic_error',
        message: `Anthropic answered ${error.status}: ${error.message}`,
      };
    }
    throw error;
  }
}

/**
 * Claude, called with the calling user's own credential: their Claude Code
 * token through the Claude Code CLI, else their Anthropic API key through the
 * Messages API. The cloud-agents plugin stores both and hands them only to
 * this plugin's service token, so neither reaches a browser.
 */
export class Reasoner {
  constructor(
    private readonly deps: {
      discovery: DiscoveryService;
      auth: AuthService;
      logger: LoggerService;
    },
    private readonly options: ClaudeCodeOptions,
  ) {}

  private async credentialOf(
    userEntityRef: string,
    signal: AbortSignal,
  ): Promise<ReasoningCredential | null> {
    const { token } = await this.deps.auth.getPluginRequestToken({
      onBehalfOf: await this.deps.auth.getOwnServiceCredentials(),
      targetPluginId: 'cloud-agents',
    });
    const base = await this.deps.discovery.getBaseUrl('cloud-agents');
    const response = await fetch(`${base}/service/reasoning-credential`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userEntityRef }),
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `cloud-agents answered ${response.status} for the credential`,
      );
    }
    return (
      (await response.json()) as { credential: ReasoningCredential | null }
    ).credential;
  }

  async ask(
    userEntityRef: string,
    question: string,
    context: string | undefined,
    signal: AbortSignal,
  ): Promise<ReasoningResult> {
    const credential = await this.credentialOf(userEntityRef, signal);
    if (!credential) {
      return { error: 'missing_claude_credential', message: SETTINGS_HINT };
    }
    const prompt = context
      ? `${question}\n\n<context>\n${context}\n</context>`
      : question;
    const started = Date.now();
    const result =
      credential.kind === 'claude_code'
        ? await askClaudeCode(
            this.options,
            credential.oauthToken,
            prompt,
            signal,
          )
        : await askMessagesApi(
            credential.apiKey,
            this.options.model,
            prompt,
            signal,
          );
    this.deps.logger.info(
      `Reasoning for ${userEntityRef} with its ${credential.kind} credential: ${
        'error' in result ? result.error : result.model
      } in ${Date.now() - started} ms`,
    );
    return result;
  }
}
