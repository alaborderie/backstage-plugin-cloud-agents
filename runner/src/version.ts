import { readFileSync } from 'node:fs';

export function runnerVersion(): string {
  if (process.env.CLOUD_AGENT_VERSION) return process.env.CLOUD_AGENT_VERSION;
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return `${pkg.version}-dev`;
}
