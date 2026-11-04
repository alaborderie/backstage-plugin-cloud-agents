import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunEvent } from '../src/events.ts';
import { gitCredential } from '../src/github-token.ts';
import { check, runProc } from '../src/proc.ts';
import { run } from '../src/run.ts';
import { configureGit, pushUnpushedWork } from '../src/workspace.ts';

const INITIAL_TOKEN = 'ghu_initialTokenFromTheSecret000000000';
const FRESH_TOKEN = 'ghu_freshTokenFromThePlugin1111111111';
const RUN_TOKEN = 'run-token-0123456789abcdef';

const FAKE_OPENCODE = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('opencode 0.0.0-fake');
  process.exit(0);
}
const prompt = args[args.length - 1];
const git = (...a) => execFileSync('git', a, { stdio: ['ignore', 'ignore', 'inherit'] });
const socket = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8')).mcp.cloud_agent.command[3];
const ask = (question) =>
  new Promise((resolve) => {
    const c = net.createConnection(socket, () => c.write(JSON.stringify({ question, blocking: true }) + '\\n'));
    c.on('data', () => {
      c.end();
      resolve();
    });
  });
(async () => {
  if (prompt.includes('own branch')) git('checkout', '-q', '-b', 'agent/own');
  writeFileSync('work.txt', prompt);
  git('add', 'work.txt');
  git('commit', '-q', '-m', 'agent work');
  if (prompt.includes('own branch')) git('push', '-q', 'origin', 'agent/own');
  if (prompt.includes('ask')) await ask('Which name?');
  console.log(JSON.stringify({ type: 'text', sessionID: 'ses_fake', part: { text: 'stopping here' } }));
})();
`;

const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(join(__dirname, 'gh-calls.jsonl'), JSON.stringify({ args, token: process.env.GH_TOKEN }) + '\\n');
if (args[0] === '--version') {
  console.log('gh version 0.0.0-fake');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  const prs = JSON.parse(readFileSync(join(__dirname, 'prs.json'), 'utf8'));
  console.log(JSON.stringify(prs[args[args.indexOf('--head') + 1]] ?? []));
  process.exit(0);
}
process.exit(1);
`;

interface PullRequest {
  url: string;
  state: string;
  createdAt: string;
}

/** A local bare repo as origin, a clone of it as the workdir, and fake opencode and gh on PATH. */
async function world(prs: Record<string, PullRequest[]>) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-agent-github-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const origin = join(root, 'origin.git');
  const workdir = join(root, 'work');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Agent\n\temail = agent@example.com\n[init]\n\tdefaultBranch = main\n');
  for (const [name, body] of [
    ['opencode', FAKE_OPENCODE],
    ['gh', FAKE_GH],
  ] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(bin, 'prs.json'), JSON.stringify(prs));
  const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home };
  const git = (cwd: string, ...args: string[]) => check('git', args, { env, cwd });
  await git(root, 'init', '--quiet', '--bare', origin);
  await git(root, 'clone', '--quiet', origin, join(root, 'seed'));
  await git(join(root, 'seed'), 'commit', '--quiet', '--allow-empty', '-m', 'base');
  await git(join(root, 'seed'), 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  await git(root, 'clone', '--quiet', origin, workdir);
  await git(join(root, 'seed'), 'push', '--quiet', 'origin', 'HEAD:refs/heads/someone/else');
  return {
    root,
    workdir,
    env,
    originSha: (ref: string) => git(root, '--git-dir', origin, 'rev-parse', '--verify', '--quiet', ref).catch(() => null),
    originLog: (ref: string) => git(root, '--git-dir', origin, 'log', '--format=%s', `main..${ref}`),
    ghCalls: () =>
      readFileSync(join(bin, 'gh-calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { args: string[]; token: string }),
  };
}

async function runAgent(w: Awaited<ReturnType<typeof world>>, prompt: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; events: RunEvent[] }> {
  const promptFile = join(w.root, 'prompt.md');
  writeFileSync(promptFile, prompt);
  const events: RunEvent[] = [];
  const code = await run(
    {
      harness: 'opencode',
      model: 'fake/model',
      effort: 'high',
      repo: 'acme/app',
      base: 'main',
      branch: 'cloud-agent/test',
      promptFile,
      workdir: w.workdir,
      runId: 'run-1',
      rawOut: null,
      installSkills: false,
    },
    { ...w.env, GH_TOKEN: INITIAL_TOKEN, OPENCODE_API_KEY: 'opencode-key-value', CLAUDE_PLUGINS_DIR: join(w.root, 'no-skills'), ...extraEnv },
    (line) => events.push(JSON.parse(line) as RunEvent),
    () => undefined,
    new AbortController().signal,
  );
  return { code, events };
}

function finished(events: RunEvent[]): Extract<RunEvent, { type: 'run.finished' }> {
  const last = events.at(-1);
  assert.equal(last?.type, 'run.finished');
  return last;
}

async function startTokenEndpoint(): Promise<{ url: string; close(): void; requests: number }> {
  const state = { requests: 0 };
  const server = createServer((req, res) => {
    state.requests += 1;
    if (req.headers.authorization !== `Bearer ${RUN_TOKEN}`) {
      res.writeHead(401).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: FRESH_TOKEN }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/cloud-agents/runner/github-token`,
    close: () => server.close(),
    get requests() {
      return state.requests;
    },
  };
}

test('a run that ends on a blocking question pushes the commits the agent left unpushed, without committing or forcing', async () => {
  const w = await world({});
  const { code, events } = await runAgent(w, 'write work.txt, then ask');
  const end = finished(events);
  assert.equal(code, 3);
  assert.equal(end.status, 'needs_input');
  assert.deepEqual(end.open_questions, ['ask-1']);
  assert.equal(await w.originSha('refs/heads/cloud-agent/test'), end.head_sha);
  assert.equal(end.pushed, true);
  assert.equal(await w.originLog('cloud-agent/test'), 'agent work');
  assert.ok(events.some((e) => e.type === 'log' && e.message === 'pushed 1 unpushed commit on cloud-agent/test'));
});

test('reports the open pull request of a branch the agent created and pushed itself', async () => {
  const now = new Date().toISOString();
  const w = await world({
    'cloud-agent/test': [],
    'agent/own': [{ url: 'https://github.com/acme/app/pull/36', state: 'OPEN', createdAt: now }],
    'someone/else': [{ url: 'https://github.com/acme/app/pull/35', state: 'OPEN', createdAt: now }],
  });
  const endpoint = await startTokenEndpoint();
  try {
    const { code, events } = await runAgent(w, 'work on your own branch', { CLOUD_AGENT_GH_TOKEN_URL: endpoint.url, CLOUD_AGENT_RUN_TOKEN: RUN_TOKEN });
    const end = finished(events);
    assert.equal(code, 0);
    assert.equal(end.status, 'succeeded');
    assert.equal(end.pr_url, 'https://github.com/acme/app/pull/36');
    const prLists = w.ghCalls().filter((c) => c.args[0] === 'pr');
    assert.deepEqual(
      prLists.map((c) => c.args[c.args.indexOf('--head') + 1]),
      ['cloud-agent/test', 'agent/own'],
    );
    assert.ok(prLists.every((c) => c.token === FRESH_TOKEN));
    assert.ok(!JSON.stringify(events).includes(RUN_TOKEN));
  } finally {
    endpoint.close();
  }
});

test('does not push commits left on the base branch', async () => {
  const w = await world({});
  const spec = { repo: 'acme/app', base: 'main', branch: 'cloud-agent/test', workdir: w.workdir, env: w.env };
  await check('git', ['commit', '--quiet', '--allow-empty', '-m', 'on main'], { env: w.env, cwd: w.workdir });
  assert.deepEqual(await pushUnpushedWork(spec), { outcome: 'not_pushed', branch: 'main', commits: 1, reason: 'main is the base or default branch' });
  assert.equal(await w.originLog('main'), '');
});

test('git gets the current GitHub token from the plugin, and GH_TOKEN when the plugin does not answer', async () => {
  const w = await world({});
  const endpoint = await startTokenEndpoint();
  const fill = async (env: Record<string, string>) => {
    const result = await runProc('git', ['credential', 'fill'], {
      env: { ...w.env, GIT_TERMINAL_PROMPT: '0', ...env },
      input: 'protocol=https\nhost=github.com\n\n',
    });
    return /^password=(.*)$/m.exec(result.stdout)?.[1];
  };
  try {
    await configureGit({ ...w.env, GH_TOKEN: INITIAL_TOKEN });
    const endpointEnv = { GH_TOKEN: INITIAL_TOKEN, CLOUD_AGENT_GH_TOKEN_URL: endpoint.url };
    assert.equal(await fill({ ...endpointEnv, CLOUD_AGENT_RUN_TOKEN: RUN_TOKEN }), FRESH_TOKEN);
    assert.equal(await fill({ ...endpointEnv, CLOUD_AGENT_RUN_TOKEN: 'finished-run' }), INITIAL_TOKEN);
    assert.equal(await fill({ GH_TOKEN: INITIAL_TOKEN }), INITIAL_TOKEN);
    assert.equal(endpoint.requests, 2);
    assert.equal(await gitCredential('get', 'protocol=https\nhost=gitlab.com\n', { GH_TOKEN: INITIAL_TOKEN }, () => undefined), '');
    assert.equal(await gitCredential('store', 'protocol=https\nhost=github.com\n', { GH_TOKEN: INITIAL_TOKEN }, () => undefined), '');
  } finally {
    endpoint.close();
  }
});
