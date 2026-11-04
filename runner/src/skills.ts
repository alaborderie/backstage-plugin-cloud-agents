import { fileURLToPath } from 'node:url';
import type { Sink } from './events.ts';
import { runProc } from './proc.ts';

export const SKILLS_SOURCE = 'github.com/alaborderie/claude-plugins';

const INSTALL_SKILLS = fileURLToPath(new URL('../scripts/install-skills.sh', import.meta.url));

function skillsDir(env: Record<string, string>): string {
  return env.CLAUDE_PLUGINS_DIR ?? '/opt/claude-plugins';
}

export async function installSkills(env: Record<string, string>, stderr: Sink): Promise<string> {
  const result = await runProc('bash', [INSTALL_SKILLS], { env, timeoutMs: 300_000, onStderrLine: stderr });
  const commit = result.stdout.trim().split('\n').pop() ?? '';
  if (result.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`installing skills from ${SKILLS_SOURCE} failed (exit ${String(result.code)}); see stderr`);
  }
  return commit;
}

export async function installedSkillsCommit(env: Record<string, string>): Promise<string | null> {
  const result = await runProc('git', ['-C', skillsDir(env), 'rev-parse', 'HEAD'], { env });
  return result.code === 0 ? result.stdout.trim() : null;
}
