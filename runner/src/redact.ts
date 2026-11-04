import { readFileSync } from 'node:fs';

export const REDACTED = '[REDACTED]';

export const CREDENTIAL_ENV = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENCODE_API_KEY',
  'CLOUD_AGENT_RUN_TOKEN',
] as const;

/** GitHub token formats. A token fetched during the run is in no variable, so its format is what gives it away. */
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;

const MIN_SECRET_LENGTH = 8;

function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringLeaves(item, out);
}

export function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const name of CREDENTIAL_ENV) {
    const value = env[name];
    if (value) values.push(value);
  }
  const authFile = env.CODEX_AUTH_JSON;
  if (authFile) {
    try {
      stringLeaves(JSON.parse(readFileSync(authFile, 'utf8')), values);
    } catch {
      // A missing or malformed file fails later, at the codex credential check.
    }
  }
  const unique = [...new Set(values.map((v) => v.trim()).filter((v) => v.length >= MIN_SECRET_LENGTH))];
  return unique.sort((a, b) => b.length - a.length);
}

export function redactString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out.replace(GITHUB_TOKEN, REDACTED);
}

export function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)]));
  }
  return value;
}
