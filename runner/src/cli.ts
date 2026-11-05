import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { serveAsk } from './ask-mcp.ts';
import { DEFAULT_SKILLS, doctor } from './doctor.ts';
import { HARNESSES } from './events.ts';
import { gitCredential, githubToken } from './github-token.ts';
import type { HarnessName } from './events.ts';
import { run } from './run.ts';
import type { RunOptions } from './run.ts';
import { runnerVersion } from './version.ts';

const USAGE = `Usage:
  cloud-agent run --harness claude|codex|opencode --model <slug> --effort <level>
                  --repo <owner/name> --base <ref> --branch <name> --prompt-file <path>
                  [--workdir <dir>] [--run-id <id>] [--raw-out <file>] [--skip-skills-install]
  cloud-agent doctor [--skill <name>]... [--skip-skills-install]
  cloud-agent mcp-ask [--socket <path>] [--hub]
  cloud-agent github-token
  cloud-agent git-credential get|store|erase
  cloud-agent version

run prints the event stream (EVENTS.md) on stdout and exits 0 succeeded, 1 failed,
2 usage error, 3 needs_input, 130 cancelled.

github-token prints the run's current GitHub token, from $CLOUD_AGENT_GH_TOKEN_URL
when set, else $GH_TOKEN. git-credential is git's credential helper for github.com.`;

class UsageError extends Error {}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EFFORT = /^[a-z]+$/;

function parseRun(argv: string[], env: NodeJS.ProcessEnv): RunOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      harness: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      repo: { type: 'string' },
      base: { type: 'string' },
      branch: { type: 'string' },
      'prompt-file': { type: 'string' },
      workdir: { type: 'string' },
      'run-id': { type: 'string' },
      'raw-out': { type: 'string' },
      'skip-skills-install': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const required = ['harness', 'model', 'effort', 'repo', 'base', 'branch', 'prompt-file'] as const;
  const missing = required.filter((k) => !values[k]);
  if (missing.length > 0) throw new UsageError(`missing --${missing.join(', --')}`);
  const harness = values.harness ?? '';
  if (!(HARNESSES as readonly string[]).includes(harness)) throw new UsageError(`--harness must be one of ${HARNESSES.join(', ')}`);
  const repo = values.repo ?? '';
  if (!REPO.test(repo)) throw new UsageError('--repo must be owner/name');
  const effort = values.effort ?? '';
  if (!EFFORT.test(effort)) throw new UsageError('--effort must be a level such as low, medium, high, xhigh');
  return {
    harness: harness as HarnessName,
    model: values.model ?? '',
    effort,
    repo,
    base: values.base ?? '',
    branch: values.branch ?? '',
    promptFile: values['prompt-file'] ?? '',
    workdir: values.workdir ?? env.CLOUD_AGENT_WORKDIR ?? `/workspace/${repo.split('/')[1] ?? 'repo'}`,
    runId: values['run-id'] ?? env.CLOUD_AGENT_RUN_ID ?? randomUUID(),
    rawOut: values['raw-out'] ?? null,
    installSkills: !values['skip-skills-install'],
  };
}

function warn(message: string): void {
  process.stderr.write(`cloud-agent: ${message}\n`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'run': {
      const opts = parseRun(rest, process.env);
      const abort = new AbortController();
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        process.on(sig, () => {
          abort.abort();
        });
      }
      return run(
        opts,
        process.env,
        (line) => process.stdout.write(`${line}\n`),
        (line) => process.stderr.write(`${line}\n`),
        abort.signal,
      );
    }
    case 'doctor': {
      const { values } = parseArgs({
        args: rest,
        options: { skill: { type: 'string', multiple: true }, 'skip-skills-install': { type: 'boolean', default: false } },
        strict: true,
      });
      const { report, ok } = await doctor(values.skill ?? DEFAULT_SKILLS, !values['skip-skills-install'], process.env, (line) => process.stderr.write(`${line}\n`));
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return ok ? 0 : 1;
    }
    case 'mcp-ask': {
      const { values } = parseArgs({ args: rest, options: { socket: { type: 'string' }, hub: { type: 'boolean', default: false } }, strict: true });
      await serveAsk(values.socket ?? null, values.hub);
      return 0;
    }
    case 'github-token':
      process.stdout.write(`${await githubToken(process.env, warn)}\n`);
      return 0;
    case 'git-credential': {
      let input = '';
      for await (const chunk of process.stdin) input += String(chunk);
      process.stdout.write(await gitCredential(rest[0], input, process.env, warn));
      return 0;
    }
    case 'version':
      process.stdout.write(`${runnerVersion()}\n`);
      return 0;
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return command === undefined ? 2 : 0;
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const usage = error instanceof UsageError || (error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'));
    process.stderr.write(`cloud-agent: ${error instanceof Error ? error.message : String(error)}\n${usage ? `${USAGE}\n` : ''}`);
    process.exitCode = usage ? 2 : 1;
  },
);
