import { fileURLToPath } from 'node:url';

/** Where the plugin serves the run's current GitHub token, and the run's token for it. */
export const TOKEN_URL_ENV = 'CLOUD_AGENT_GH_TOKEN_URL';
export const RUN_TOKEN_ENV = 'CLOUD_AGENT_RUN_TOKEN';

const FETCH_TIMEOUT_MS = 10_000;

const CLI = fileURLToPath(new URL('../bin/cloud-agent', import.meta.url));

/** The variables git, `gh`, and the credential helper need: `GH_TOKEN` and, when set, the token endpoint. */
export function githubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['GH_TOKEN', TOKEN_URL_ENV, RUN_TOKEN_ENV]) {
    const value = env[name];
    if (value) out[name] = value;
  }
  return out;
}

/**
 * The run's current GitHub token. The plugin refreshes a GitHub App user token while runs go on, which
 * invalidates the one in `GH_TOKEN`, so a pod that has the plugin's endpoint asks it each time. When the
 * endpoint fails, or the pod has none, this is `GH_TOKEN`.
 */
export async function githubToken(env: NodeJS.ProcessEnv, warn: (message: string) => void): Promise<string> {
  const url = env[TOKEN_URL_ENV];
  const runToken = env[RUN_TOKEN_ENV];
  if (url && runToken) {
    let problem: string;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${runToken}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = response.ok ? ((await response.json()) as { token?: unknown }) : {};
      if (typeof body.token === 'string' && body.token !== '') return body.token;
      problem = response.ok ? 'no token in the answer' : `HTTP ${String(response.status)}`;
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
    if (!env.GH_TOKEN) throw new Error(`could not fetch the GitHub token from ${url}: ${problem}`);
    warn(`could not fetch the GitHub token from ${url} (${problem}); using GH_TOKEN`);
  }
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN is not set');
  return env.GH_TOKEN;
}

/** The `git credential` helper for github.com: answers `get` with the current token, ignores `store` and `erase`. */
export async function gitCredential(operation: string | undefined, input: string, env: NodeJS.ProcessEnv, warn: (message: string) => void): Promise<string> {
  if (operation !== 'get') return '';
  const fields = new Map(input.split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (fields.get('host') !== 'github.com') return '';
  return `username=x-access-token\npassword=${await githubToken(env, warn)}\n`;
}

/** The git config value that makes `cloud-agent git-credential` git's helper for github.com. */
export function credentialHelper(): string {
  return `!'${CLI}' git-credential`;
}
