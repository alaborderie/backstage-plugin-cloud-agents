import { createWriteStream, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAskChannel } from './ask-channel.ts';
import type { WriteStream } from 'node:fs';
import { Emitter, EXIT_CODES, addUsage, emptyUsage } from './events.ts';
import type { EventBody, HarnessName, RunStatus, Sink } from './events.ts';
import { harnesses } from './harnesses/index.ts';
import { questionEvents } from './harnesses/types.ts';
import type { Harness, RunSpec } from './harnesses/types.ts';
import { baseEnv, runProc } from './proc.ts';
import { collectSecrets, redactString } from './redact.ts';
import { SKILLS_SOURCE, installSkills, installedSkillsCommit } from './skills.ts';
import { runnerVersion } from './version.ts';
import { githubEnv, githubToken } from './github-token.ts';
import { branchState, configureGit, prepareWorkspace, pushUnpushedWork } from './workspace.ts';
import type { UnpushedWork, WorkspaceSpec } from './workspace.ts';

export interface RunOptions {
  harness: HarnessName;
  model: string;
  effort: string;
  repo: string;
  base: string;
  branch: string;
  promptFile: string;
  workdir: string;
  runId: string;
  rawOut: string | null;
  installSkills: boolean;
}

function unpushedWorkLog(work: UnpushedWork): EventBody {
  const commits = `${String(work.commits)} unpushed commit${work.commits === 1 ? '' : 's'} on ${work.branch}`;
  switch (work.outcome) {
    case 'pushed':
      return { type: 'log', level: 'info', source: 'runner', message: `pushed ${commits}` };
    case 'push_failed':
      return { type: 'log', level: 'warn', source: 'runner', message: `could not push ${commits}: ${work.error}` };
    case 'not_pushed':
      return { type: 'log', level: 'warn', source: 'runner', message: `left ${commits}: ${work.reason}` };
  }
}

export async function harnessVersion(harness: Harness, env: Record<string, string>): Promise<string | null> {
  const result = await runProc(harness.binary, ['--version'], { env, timeoutMs: 30_000 });
  return result.code === 0 ? result.stdout.trim().split('\n')[0] ?? null : null;
}

async function runHarness(
  harness: Harness,
  spec: RunSpec,
  env: Record<string, string>,
  emitter: Emitter,
  raw: WriteStream | null,
  secrets: readonly string[],
  stderr: Sink,
  signal: AbortSignal,
): Promise<{ code: number | null; error: string | null }> {
  const translator = harness.createTranslator();
  const invocation = harness.invocation(spec);
  let lastStderr = '';
  const result = await runProc(invocation.command, invocation.args, {
    env,
    cwd: spec.workdir,
    ...(invocation.stdin === null ? {} : { input: invocation.stdin }),
    signal,
    onStdoutLine: (line) => {
      raw?.write(`${redactString(line, secrets)}\n`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (line.trim() !== '') emitter.emit({ type: 'log', level: 'info', source: 'harness', message: line.slice(0, 2000) });
        return;
      }
      for (const body of translator.translate(parsed)) emitter.emit(body);
    },
    onStderrLine: (line) => {
      if (line.trim() !== '') lastStderr = line;
      stderr(line);
    },
  });
  const translated = translator.error();
  if (result.code !== 0) {
    const detail = translated ?? (lastStderr === '' ? null : redactString(lastStderr, secrets));
    return { code: result.code, error: `${harness.name} exited with code ${String(result.code)}${detail ? `: ${detail}` : ''}` };
  }
  return { code: result.code, error: translated };
}

export async function run(opts: RunOptions, env: NodeJS.ProcessEnv, stdout: Sink, stderrRaw: Sink, signal: AbortSignal): Promise<number> {
  const startedAt = new Date();
  const secrets = collectSecrets(env);
  const stderr: Sink = (line) => {
    stderrRaw(redactString(line, secrets));
  };
  const emitter = new Emitter(opts.runId, secrets, stdout);
  const harness = harnesses[opts.harness];
  const plainEnv = baseEnv(env);
  const gitEnv = { ...plainEnv, ...githubEnv(env) };
  const workspace: WorkspaceSpec = { repo: opts.repo, base: opts.base, branch: opts.branch, workdir: opts.workdir, env: gitEnv };
  const raw = opts.rawOut ? createWriteStream(opts.rawOut, { flags: 'a', mode: 0o600 }) : null;

  emitter.emit({
    type: 'run.started',
    harness: opts.harness,
    model: opts.model,
    effort: opts.effort,
    repo: opts.repo,
    base: opts.base,
    branch: opts.branch,
    runner_version: runnerVersion(),
    harness_version: await harnessVersion(harness, plainEnv),
  });

  let error: string | null;
  let harnessExit: number | null = null;
  try {
    if (!env.GH_TOKEN) throw new Error('GH_TOKEN is required to clone, push, and open pull requests');
    const spec: RunSpec = {
      model: opts.model,
      effort: opts.effort,
      prompt: readFileSync(opts.promptFile, 'utf8'),
      workdir: opts.workdir,
      home: env.HOME ?? '/home/agent',
      askSocket: join(tmpdir(), `cloud-agent-ask-${String(process.pid)}.sock`),
    };
    const harnessEnv = { ...gitEnv, ...harness.prepare(spec, env) };
    await configureGit(gitEnv);
    const commit = opts.installSkills ? await installSkills(gitEnv, stderr) : await installedSkillsCommit(gitEnv);
    if (commit) emitter.emit({ type: 'skills.ready', source: SKILLS_SOURCE, commit });
    else emitter.emit({ type: 'log', level: 'warn', source: 'runner', message: 'skills install skipped and none installed' });
    if (signal.aborted) throw new Error('cancelled');
    const ws = await prepareWorkspace(workspace);
    emitter.emit({ type: 'workspace.ready', repo: opts.repo, branch: opts.branch, base: opts.base, ...ws });
    let asked = 0;
    const channel = await openAskChannel(spec.askSocket, (input) => {
      for (const body of questionEvents(`ask-${String(++asked)}`, input, 'ask_user')) emitter.emit(body);
      return { answer: null };
    });
    const outcome = await runHarness(harness, spec, harnessEnv, emitter, raw, secrets, stderr, signal).finally(() => channel.close());
    harnessExit = outcome.code;
    error = outcome.error;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const openQuestions = emitter.emitted.flatMap((e) => (e.type === 'question' && e.blocking ? [e.question_id] : []));
  const status: RunStatus = signal.aborted ? 'cancelled' : error !== null ? 'failed' : openQuestions.length > 0 ? 'needs_input' : 'succeeded';
  const token = await githubToken(env, stderr).catch(() => null);
  const finishing: WorkspaceSpec = { ...workspace, env: { ...gitEnv, ...(token ? { GH_TOKEN: token } : {}) } };
  if (status !== 'cancelled') {
    const work = await pushUnpushedWork(finishing);
    if (work) emitter.emit(unpushedWorkLog(work));
  }
  const state = await branchState(finishing, startedAt);
  const usage = emitter.emitted.reduce((total, e) => (e.type === 'usage' ? addUsage(total, e) : total), emptyUsage());
  emitter.emit({
    type: 'run.finished',
    status,
    exit_code: EXIT_CODES[status],
    harness_exit_code: harnessExit,
    branch: opts.branch,
    ...state,
    open_questions: openQuestions,
    usage,
    duration_ms: Date.now() - startedAt.getTime(),
    error: status === 'cancelled' ? (error ?? 'cancelled') : error,
  });
  if (raw) await new Promise<void>((resolve) => {
    raw.end(resolve);
  });
  return EXIT_CODES[status];
}
