import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESSES } from './events.ts';
import { githubEnv } from './github-token.ts';
import type { HarnessName, Sink } from './events.ts';
import { harnesses } from './harnesses/index.ts';
import { rec, str } from './json.ts';
import { baseEnv, runProc } from './proc.ts';
import { redactString, collectSecrets } from './redact.ts';
import { harnessVersion } from './run.ts';
import { installSkills, installedSkillsCommit } from './skills.ts';
import { runnerVersion } from './version.ts';
import { configureGit } from './workspace.ts';

export const DEFAULT_SKILLS = ['t3-hub', 'poteto-mode', 'full-send'];

interface HarnessReport {
  version: string | null;
  skills: Record<string, boolean>;
  evidence: string;
  ok: boolean;
}

type SkillProbe = (env: Record<string, string>, cwd: string) => Promise<{ text: string; evidence: string }>;

/** Claude Code prints its init event, skills included, before it authenticates; with no credential it stops there. */
const claudeProbe: SkillProbe = async (env, cwd) => {
  const result = await runProc('claude', ['-p', '--output-format', 'stream-json', '--verbose', 'doctor'], { env, cwd, timeoutMs: 120_000 });
  for (const line of result.stdout.split('\n')) {
    try {
      const msg = rec(JSON.parse(line));
      if (msg.type === 'system' && msg.subtype === 'init') {
        const skills = Array.isArray(msg.skills) ? msg.skills.map(String) : [];
        const plugins = Array.isArray(msg.plugins) ? msg.plugins.map((p) => str(rec(p).name) ?? '') : [];
        return { text: skills.map((s) => `<skill:${s}>`).join(''), evidence: `init event: ${String(skills.length)} skills; plugins: ${plugins.join(', ')}` };
      }
    } catch {
      // Non-JSON lines are not the init event.
    }
  }
  return { text: '', evidence: `no init event (exit ${String(result.code)})` };
};

/** `codex debug prompt-input` renders the model-visible prompt, which lists each skill with its SKILL.md path. */
const codexProbe: SkillProbe = async (env, cwd) => {
  const result = await runProc('codex', ['debug', 'prompt-input'], { env, cwd, timeoutMs: 120_000 });
  const text = [...result.stdout.matchAll(/\(file: [^)]*?\/([^/)]+)\/SKILL\.md\)/g)].map((m) => `<skill:${m[1] ?? ''}>`).join('');
  return { text, evidence: `codex debug prompt-input (exit ${String(result.code)})` };
};

/** OpenCode lists skills in the request it sends its model, so point it at a local fake provider and read that request. */
const opencodeProbe: SkillProbe = async (env, cwd) => {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      bodies.push(body);
      const chunk = (delta: object, finish: string | null): string =>
        `data: ${JSON.stringify({ id: 'doctor', object: 'chat.completion.chunk', created: 0, model: 'probe', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`${chunk({ role: 'assistant', content: 'ok' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const config = join(cwd, 'opencode-doctor.json');
  writeFileSync(
    config,
    JSON.stringify({
      provider: { doctor: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${String(port)}/v1`, apiKey: 'none' }, models: { probe: {} } } },
    }),
  );
  const result = await runProc('opencode', ['run', '--standalone', '--format', 'json', '--model', 'doctor/probe', 'doctor'], {
    env: { ...env, OPENCODE_CONFIG: config },
    cwd,
    timeoutMs: 120_000,
  });
  server.close();
  const text = [...bodies.join('\n').matchAll(/<name>([^<]+)<\/name>/g)].map((m) => `<skill:${m[1] ?? ''}>`).join('');
  return { text, evidence: `request captured by a local fake provider (${String(bodies.length)} requests, opencode exit ${String(result.code)})` };
};

const PROBES: Record<HarnessName, SkillProbe> = { claude: claudeProbe, codex: codexProbe, opencode: opencodeProbe };

async function prepareSkills(install: boolean, env: NodeJS.ProcessEnv, stderr: Sink): Promise<{ commit: string | null; error: string | null }> {
  const plain = baseEnv(env);
  if (!install) return { commit: await installedSkillsCommit(plain), error: null };
  if (!env.GH_TOKEN) return { commit: await installedSkillsCommit(plain), error: 'GH_TOKEN is not set, so the private skills repo was not fetched' };
  const gitEnv = { ...plain, ...githubEnv(env) };
  try {
    await configureGit(gitEnv);
    return { commit: await installSkills(gitEnv, stderr), error: null };
  } catch (e) {
    return { commit: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function doctor(skills: string[], install: boolean, env: NodeJS.ProcessEnv, stderrRaw: Sink): Promise<{ report: object; ok: boolean }> {
  const secrets = collectSecrets(env);
  const skillsState = await prepareSkills(install, env, (line) => {
    stderrRaw(redactString(line, secrets));
  });
  const plain = baseEnv(env);
  const cwd = mkdtempSync(join(tmpdir(), 'cloud-agent-doctor-'));
  const reports: Partial<Record<HarnessName, HarnessReport>> = {};
  try {
    await runProc('git', ['init', '--quiet', cwd], { env: plain });
    for (const name of HARNESSES) {
      const version = await harnessVersion(harnesses[name], plain);
      const probe = await PROBES[name](plain, cwd);
      const seen = Object.fromEntries(skills.map((s) => [s, probe.text.includes(`<skill:${s}>`)]));
      reports[name] = { version, skills: seen, evidence: probe.evidence, ok: version !== null && Object.values(seen).every(Boolean) };
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const tools = Object.fromEntries(
    await Promise.all(
      (['git', 'gh', 'node', 'python3'] as const).map(async (bin) => {
        const r = await runProc(bin, ['--version'], { env: plain });
        return [bin, r.code === 0 ? r.stdout.trim().split('\n')[0] ?? null : null] as const;
      }),
    ),
  );
  const ok = Object.values(reports).every((r) => r.ok);
  return {
    ok,
    report: {
      ok,
      runner_version: runnerVersion(),
      skills_commit: skillsState.commit,
      skills_error: skillsState.error,
      harnesses: reports,
      tools,
    },
  };
}
