import {
  mockCredentials,
  TestDatabases,
  type TestBackend,
} from '@backstage/backend-test-utils';
import type { Knex } from 'knex';
import type {
  Agent,
  CredentialsSummary,
} from '@alaborderie/plugin-cloud-agents-common';
import { FakeKube, recordedStream } from './__testUtils__/fakeKube';
import {
  CapturedLogs,
  readSse,
  startFakeGithub,
  startPluginBackend,
  waitFor,
} from './__testUtils__/harness';

jest.setTimeout(60_000);

const ALICE = mockCredentials.user.header('user:default/alice');
const BOB = mockCredentials.user.header('user:default/bob');
const OPENCODE_KEY = 'sk-opencode-SECRET-0123456789';
const CLAUDE_TOKEN = 'sk-ant-oat-SECRET-abcdef';
const CODEX_KEY = 'sk-codex-SECRET-xyz987';
const GITHUB_TOKEN = 'ghu_SECRET_github_token_42';
const SECRETS = [OPENCODE_KEY, CLAUDE_TOKEN, CODEX_KEY, GITHUB_TOKEN];

const databases = TestDatabases.create({ ids: ['SQLITE_3', 'POSTGRES_16'] });

describe.each(databases.eachSupportedId())('cloud-agents on %s', databaseId => {
  let knex: Knex;
  let kube: FakeKube;
  let kubeUrl: string;
  let github: Awaited<ReturnType<typeof startFakeGithub>>;
  let logs: CapturedLogs;
  let backend: TestBackend;
  let baseUrl: string;

  async function start(githubApp = false) {
    ({ backend, baseUrl } = await startPluginBackend({
      knex,
      kube,
      kubeUrl,
      githubUrl: github.url,
      logs,
      githubApp,
    }));
  }

  async function api(
    method: string,
    path: string,
    body?: unknown,
    auth = ALICE,
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: auth,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function setCredentials(auth = ALICE) {
    github.logins.set(GITHUB_TOKEN, 'alice-gh');
    expect(
      (
        await api(
          'PUT',
          '/me/credentials/opencode',
          { value: OPENCODE_KEY },
          auth,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await api(
          'PUT',
          '/me/credentials/github',
          { value: GITHUB_TOKEN },
          auth,
        )
      ).status,
    ).toBe(200);
  }

  async function agentWhen(
    id: string,
    predicate: (a: Agent) => boolean,
  ): Promise<Agent> {
    return waitFor(async () => {
      const { body } = await api('GET', `/agents/${id}`);
      return predicate(body) ? (body as Agent) : undefined;
    });
  }

  beforeAll(async () => {
    knex = await databases.init(databaseId);
    github = await startFakeGithub();
  });

  beforeEach(async () => {
    kube = new FakeKube();
    kubeUrl = await kube.start();
    logs = new CapturedLogs();
    await start();
  });

  afterEach(async () => {
    await backend.stop();
    await kube.stop();
  });

  afterAll(async () => {
    await github.close();
  });

  it('stores credentials sealed, reports only whether they are set, and clears them', async () => {
    await setCredentials();
    await api('PUT', '/me/credentials/claude', { value: CLAUDE_TOKEN });
    await api('PUT', '/me/credentials/codex', {
      value: CODEX_KEY,
      kind: 'api_key',
    });

    const { status, body } = await api('GET', '/me/credentials');
    expect(status).toBe(200);
    const summary = body as CredentialsSummary;
    expect(summary.opencode.set).toBe(true);
    expect(summary.claude.set).toBe(true);
    expect(summary.codex).toMatchObject({ set: true, kind: 'api_key' });
    expect(summary.github).toMatchObject({
      connected: true,
      login: 'alice-gh',
      method: 'token',
      connectAvailable: false,
    });

    const dump = JSON.stringify(await knex('credentials').select());
    for (const secret of SECRETS) {
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(dump).not.toContain(secret);
    }
    expect(dump).toContain('v1:');

    const other = (await api('GET', '/me/credentials', undefined, BOB))
      .body as CredentialsSummary;
    expect(other.opencode.set).toBe(false);

    for (const name of ['claude', 'codex', 'opencode', 'github']) {
      expect((await api('DELETE', `/me/credentials/${name}`)).status).toBe(200);
    }
    const cleared = (await api('GET', '/me/credentials'))
      .body as CredentialsSummary;
    expect([
      cleared.claude.set,
      cleared.codex.set,
      cleared.opencode.set,
      cleared.github.connected,
    ]).toEqual([false, false, false, false]);
  });

  it('rejects a codex credential without kind and a GitHub token GitHub does not accept', async () => {
    expect(
      (await api('PUT', '/me/credentials/codex', { value: CODEX_KEY })).status,
    ).toBe(400);
    expect(
      (await api('PUT', '/me/credentials/github', { value: 'ghu_unknown' }))
        .status,
    ).toBe(400);
    expect(
      (await api('PUT', '/me/credentials/nope', { value: 'x' })).status,
    ).toBe(400);
  });

  it('answers 422 missing_credential when the harness credential is not set', async () => {
    const { status, body } = await api('POST', '/agents', {
      repo: 'acme/app',
      prompt: 'do it',
      tier: 'flash',
    });
    expect(status).toBe(422);
    expect(body).toMatchObject({
      error: 'missing_credential',
      harness: 'opencode',
    });
    expect(kube.jobs.size).toBe(0);
  });

  it('runs an agent end to end and replays its stream from Last-Event-ID', async () => {
    await setCredentials();
    const created = await api('POST', '/agents', {
      repo: 'alaborderie/cloud-agent-runner-sandbox',
      base: 'main',
      prompt: 'Write hello.txt\nand open a PR',
      tier: 'flash',
      parent: { source: 't3', threadId: 'th_1' },
    });
    expect(created.status).toBe(201);
    const agent = created.body as Agent;
    expect(agent).toMatchObject({
      id: expect.stringMatching(/^ag_[0-9a-f]{12}$/),
      title: 'Write hello.txt',
      harness: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      effort: 'high',
      branch: `cloud-agent/${agent.id.slice(3)}`,
      parent: { source: 't3', threadId: 'th_1' },
    });
    expect(agent.runs).toHaveLength(1);

    const job = [...kube.jobs.values()][0]!;
    const container = job.spec!.template.spec!.containers[0]!;
    expect(container.args).toEqual(
      expect.arrayContaining([
        '--harness',
        'opencode',
        '--branch',
        agent.branch,
      ]),
    );
    const secret = [...kube.secrets.values()][0]!;
    expect(Object.keys(secret.stringData!).sort()).toEqual([
      'GH_TOKEN',
      'OPENCODE_API_KEY',
      'prompt.md',
    ]);
    expect(secret.metadata!.ownerReferences![0]).toMatchObject({
      kind: 'Job',
      uid: job.metadata!.uid,
    });
    expect(JSON.stringify(job)).not.toContain(OPENCODE_KEY);

    const first = await readSse(`${baseUrl}/agents/${agent.id}/events`, {
      Authorization: ALICE,
    });
    expect(first.closedByServer).toBe(true);
    const seqs = first.messages.map(m => m.id);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(
      first.messages.every(
        m => m.event === 'agent-event' && m.data.seq === m.id,
      ),
    ).toBe(true);
    const runnerEvents = first.messages.filter(
      m => !m.data.event.type.startsWith('agent.'),
    );
    expect(runnerEvents.map(m => JSON.stringify(m.data.event))).toEqual(
      recordedStream('opencode').map(line =>
        JSON.stringify({ ...JSON.parse(line), run_id: agent.runs[0]!.id }),
      ),
    );
    const last = first.messages[first.messages.length - 1]!;
    expect(last.data.event).toMatchObject({
      type: 'agent.status',
      status: 'succeeded',
    });
    expect(first.messages[0]!.data.event).toMatchObject({
      type: 'agent.run_started',
      reason: 'initial',
    });

    const done = (await api('GET', `/agents/${agent.id}`)).body as Agent;
    expect(done.status).toBe('succeeded');
    expect(done.prUrl).toBe(
      'https://github.com/alaborderie/cloud-agent-runner-sandbox/pull/3',
    );
    expect(done.runs[0]).toMatchObject({ status: 'succeeded', exitCode: 0 });

    const resumeAt = seqs[9]!;
    const replay = await readSse(`${baseUrl}/agents/${agent.id}/events`, {
      Authorization: ALICE,
      'Last-Event-ID': String(resumeAt),
    });
    expect(replay.messages).toEqual(first.messages.slice(10));
    const viaQuery = await readSse(
      `${baseUrl}/agents/${agent.id}/events?after=${resumeAt}`,
      { Authorization: ALICE },
    );
    expect(viaQuery.messages).toEqual(first.messages.slice(10));
    const atEnd = await readSse(`${baseUrl}/agents/${agent.id}/events`, {
      Authorization: ALICE,
      'Last-Event-ID': String(last.id),
    });
    expect(atEnd).toMatchObject({ messages: [], closedByServer: true });

    const listed = (await api('GET', '/agents?status=succeeded'))
      .body as Agent[];
    expect(listed.map(a => a.id)).toEqual([agent.id]);
    expect((await api('GET', '/agents?status=running')).body).toEqual([]);
    expect(
      (await api('GET', `/agents/${agent.id}`, undefined, BOB)).status,
    ).toBe(404);

    const stored = JSON.stringify(await knex('events').select());
    for (const s of SECRETS) {
      expect(stored).not.toContain(s);
      expect(logs.text()).not.toContain(s);
    }
  });

  it('resumes following a run after a restart from the stored seq', async () => {
    await setCredentials();
    kube.script = () => ({
      lines: recordedStream('opencode'),
      exitCode: 0,
      holdAt: 12,
    });
    const agent = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'p',
        tier: 'flash',
      })
    ).body as Agent;
    const runId = agent.runs[0]!.id;
    await waitFor(
      async () =>
        (await knex('runs').where({ id: runId }).first()).runner_seq === 11,
    );

    const live = await readSse(
      `${baseUrl}/agents/${agent.id}/events`,
      { Authorization: ALICE },
      m => m.length >= 10,
    );
    await backend.stop();
    await start();
    kube.release(runId);

    const rest = await readSse(`${baseUrl}/agents/${agent.id}/events`, {
      Authorization: ALICE,
      'Last-Event-ID': String(live.messages[live.messages.length - 1]!.id),
    });
    expect(rest.closedByServer).toBe(true);
    const all = [...live.messages, ...rest.messages];
    expect(all.map(m => m.id)).toEqual(all.map((_, i) => i + 1));
    const runnerSeqs = all
      .filter(m => !m.data.event.type.startsWith('agent.'))
      .map(m => m.data.event.seq);
    expect(runnerSeqs).toEqual([...Array(29).keys()]);
    expect((await api('GET', `/agents/${agent.id}`)).body.status).toBe(
      'succeeded',
    );
  });

  it('ends a run that asks a blocking question as needs_input and starts the next run on reply', async () => {
    await setCredentials();
    const scripts = [
      recordedStream('opencode-needs-input'),
      recordedStream('opencode'),
    ];
    kube.script = () => ({ lines: scripts.shift()!, exitCode: 0 });
    const agent = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'Original brief',
        tier: 'flash',
      })
    ).body as Agent;

    const waiting = await agentWhen(agent.id, a => a.status === 'needs_input');
    expect(waiting.openQuestions).toEqual([
      expect.objectContaining({
        questionId: 'ask-1',
        runId: agent.runs[0]!.id,
        options: expect.any(Array),
      }),
    ]);
    const stream = await readSse(
      `${baseUrl}/agents/${agent.id}/events`,
      { Authorization: ALICE },
      m =>
        m.some(
          x =>
            x.data.event.type === 'agent.status' &&
            x.data.event.status === 'needs_input',
        ),
    );
    expect(stream.closedByServer).toBe(false);

    expect(
      (await api('POST', `/agents/${agent.id}/messages`, { text: 'x' })).status,
    ).toBe(202);
    await agentWhen(agent.id, a => a.status === 'succeeded');
    expect(
      (
        await api('POST', `/agents/${agent.id}/reply`, {
          questionId: 'ask-1',
          answer: 'hello',
        })
      ).status,
    ).toBe(409);
  });

  it('starts a reply run whose prompt holds the question and the answer', async () => {
    await setCredentials();
    const scripts = [
      recordedStream('opencode-needs-input'),
      recordedStream('opencode'),
    ];
    kube.script = () => ({ lines: scripts.shift()!, exitCode: 0 });
    const agent = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'Original brief',
        tier: 'flash',
      })
    ).body as Agent;
    const waiting = await agentWhen(agent.id, a => a.status === 'needs_input');
    const question = waiting.openQuestions[0]!;

    expect(
      (
        await api('POST', `/agents/${agent.id}/reply`, {
          questionId: 'nope',
          answer: 'x',
        })
      ).status,
    ).toBe(404);
    const replied = await api('POST', `/agents/${agent.id}/reply`, {
      questionId: question.questionId,
      answer: 'bonjour',
    });
    expect(replied.status).toBe(202);

    const done = await agentWhen(agent.id, a => a.status === 'succeeded');
    expect(done.runs.map(r => r.status)).toEqual(['needs_input', 'succeeded']);
    expect(done.openQuestions).toEqual([]);
    const secondPrompt = [...kube.secrets.values()][1]!.stringData![
      'prompt.md'
    ]!;
    expect(secondPrompt).toContain('Original brief');
    expect(secondPrompt).toContain(question.question);
    expect(secondPrompt).toContain('bonjour');
    const jobs = [...kube.jobs.values()];
    expect(jobs[1]!.spec!.template.spec!.containers[0]!.args).toEqual(
      expect.arrayContaining(['--branch', agent.branch]),
    );

    const events = await readSse(`${baseUrl}/agents/${agent.id}/events`, {
      Authorization: ALICE,
    });
    const started = events.messages.filter(
      m => m.data.event.type === 'agent.run_started',
    );
    expect(started.map(m => m.data.event.reason)).toEqual(['initial', 'reply']);
  });

  it('starts exactly one run when concurrent replies answer the last questions', async () => {
    await setCredentials();
    const twoQuestions = recordedStream('opencode-needs-input')
      .flatMap(line => {
        const event = JSON.parse(line);
        if (event.type === 'question' && event.question_id === 'ask-1') {
          return [
            line,
            JSON.stringify({
              ...event,
              question_id: 'ask-2',
              question: 'Which file name?',
            }),
          ];
        }
        if (event.type === 'run.finished') {
          return [
            JSON.stringify({ ...event, open_questions: ['ask-1', 'ask-2'] }),
          ];
        }
        return [line];
      })
      .map((line, seq) => JSON.stringify({ ...JSON.parse(line), seq }));
    const scripts = [twoQuestions, recordedStream('opencode')];
    kube.script = () => ({ lines: scripts.shift()!, exitCode: 0 });
    const agent = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'p',
        tier: 'flash',
      })
    ).body as Agent;
    const waiting = await agentWhen(agent.id, a => a.status === 'needs_input');
    expect(waiting.openQuestions.map(q => q.questionId)).toEqual([
      'ask-1',
      'ask-2',
    ]);

    const replies = await Promise.all([
      api('POST', `/agents/${agent.id}/reply`, {
        questionId: 'ask-1',
        answer: 'hello',
      }),
      api('POST', `/agents/${agent.id}/reply`, {
        questionId: 'ask-2',
        answer: 'hello.txt',
      }),
    ]);
    expect(replies.map(r => r.status)).toEqual([202, 202]);
    const done = await agentWhen(agent.id, a => a.status === 'succeeded');
    expect(done.runs).toHaveLength(2);
    expect(kube.jobs.size).toBe(2);
    const prompt = [...kube.secrets.values()][1]!.stringData!['prompt.md']!;
    expect(prompt).toContain('hello.txt');
    expect(prompt).toContain('Which file name?');
  });

  it('starts one follow-up run when two messages race', async () => {
    await setCredentials();
    const agent = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'p',
        tier: 'flash',
      })
    ).body as Agent;
    await agentWhen(agent.id, a => a.status === 'succeeded');
    const messages = await Promise.all([
      api('POST', `/agents/${agent.id}/messages`, { text: 'one' }),
      api('POST', `/agents/${agent.id}/messages`, { text: 'two' }),
    ]);
    expect(messages.map(r => r.status).sort()).toEqual([202, 409]);
    const done = await agentWhen(
      agent.id,
      a => a.status === 'succeeded' && a.runs.length === 2,
    );
    expect(done.runs).toHaveLength(2);
    expect(kube.jobs.size).toBe(2);
  });

  it('stops an agent: deletes the Job, stores the cancelled run.finished, and closes the stream', async () => {
    await setCredentials();
    const lines = recordedStream('opencode-cancelled');
    kube.script = () => ({
      lines: lines.slice(0, 4),
      onCancel: lines.slice(4),
      exitCode: 0,
      holdAt: 4,
    });
    const agent = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'p',
        tier: 'flash',
      })
    ).body as Agent;
    await agentWhen(agent.id, a => a.status === 'running');
    expect(
      (await api('POST', `/agents/${agent.id}/messages`, { text: 'again' }))
        .status,
    ).toBe(409);

    const streaming = readSse(`${baseUrl}/agents/${agent.id}/events`, {
      Authorization: ALICE,
    });
    expect((await api('POST', `/agents/${agent.id}/stop`)).status).toBe(202);
    const { messages, closedByServer } = await streaming;
    expect(closedByServer).toBe(true);
    expect(messages.map(m => m.data.event.type).slice(-2)).toEqual([
      'run.finished',
      'agent.status',
    ]);
    expect(messages[messages.length - 1]!.data.event).toMatchObject({
      status: 'stopped',
    });
    expect(kube.jobs.size).toBe(0);
    expect(kube.secrets.size).toBe(0);
    const stopped = (await api('GET', `/agents/${agent.id}`)).body as Agent;
    expect(stopped.runs[0]).toMatchObject({ status: 'stopped', exitCode: 130 });
  });

  it('fails a run whose pod disappears without run.finished', async () => {
    await setCredentials();
    kube.script = () => ({
      lines: recordedStream('opencode').slice(0, 3),
      exitCode: 0,
      holdAt: 3,
    });
    const agent = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'p',
        tier: 'flash',
      })
    ).body as Agent;
    await waitFor(
      async () =>
        (
          await knex('runs').where({ id: agent.runs[0]!.id }).first()
        ).runner_seq === 2,
    );
    kube.vanish(agent.runs[0]!.id);
    const failed = await agentWhen(agent.id, a => a.status === 'failed');
    expect(failed.runs[0]).toMatchObject({ status: 'failed', exitCode: null });
  });

  it('authenticates cat_ tokens as their owner and forgets deleted ones', async () => {
    const created = await api('POST', '/me/tokens', { name: 't3 bridge' });
    expect(created.status).toBe(201);
    const { id, token } = created.body as { id: string; token: string };
    expect(token).toMatch(/^cat_[A-Za-z0-9_-]{43}$/);
    const listed = (await api('GET', '/me/tokens')).body;
    expect(listed).toEqual([
      expect.objectContaining({ id, name: 't3 bridge', lastUsedAt: null }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(await knex('access_tokens').select())).not.toContain(
      token,
    );

    const bearer = `Bearer ${token}`;
    await setCredentials(bearer);
    expect((await api('GET', '/me/credentials')).body.opencode.set).toBe(true);
    const agent = (
      await api(
        'POST',
        '/agents',
        { repo: 'acme/app', prompt: 'p', tier: 'flash' },
        bearer,
      )
    ).body as Agent;
    expect((await api('GET', `/agents/${agent.id}`)).status).toBe(200);
    expect(
      (await api('GET', `/agents/${agent.id}`, undefined, BOB)).status,
    ).toBe(404);
    const sse = await readSse(`${baseUrl}/agents/${agent.id}/events`, {
      Authorization: bearer,
    });
    expect(sse.closedByServer).toBe(true);

    expect(
      (await api('DELETE', `/me/tokens/${id}`, undefined, BOB)).status,
    ).toBe(404);
    expect((await api('DELETE', `/me/tokens/${id}`)).status).toBe(204);
    expect((await api('GET', '/agents', undefined, bearer)).status).toBe(401);
    expect(
      (await api('GET', '/agents', undefined, 'Bearer cat_unknown')).status,
    ).toBe(401);
    expect(
      (await api('GET', '/agents', undefined, mockCredentials.none.header()))
        .status,
    ).toBe(401);
  });

  it('connects GitHub through the App web flow and refreshes the token for each run', async () => {
    await backend.stop();
    await start(true);
    expect(
      (await api('GET', '/me/credentials')).body.github.connectAvailable,
    ).toBe(true);

    const connect = await fetch(`${baseUrl}/me/github/connect`, {
      headers: { Authorization: ALICE, Accept: 'application/json' },
    });
    const { url } = (await connect.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe(
      `${github.url}/login/oauth/authorize`,
    );
    expect(authorize.searchParams.get('client_id')).toBe('app-client');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'http://localhost:7007/api/cloud-agents/me/github/callback',
    );
    const state = authorize.searchParams.get('state')!;

    const redirect = await fetch(`${baseUrl}/me/github/connect`, {
      headers: { Authorization: ALICE },
      redirect: 'manual',
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toContain(
      '/login/oauth/authorize?',
    );

    github.codes.set('code-1', 'alice-gh');
    const callback = await fetch(
      `${baseUrl}/me/github/callback?code=code-1&state=${state}`,
      { redirect: 'manual' },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(
      'http://localhost:3000/cloud-agents/settings?github=connected',
    );
    const replayed = await fetch(
      `${baseUrl}/me/github/callback?code=code-1&state=${state}`,
      { redirect: 'manual' },
    );
    expect(replayed.status).toBe(401);
    expect((await api('GET', '/me/credentials')).body.github).toMatchObject({
      connected: true,
      login: 'alice-gh',
      method: 'oauth',
    });

    await api('PUT', '/me/credentials/opencode', { value: OPENCODE_KEY });
    await api('POST', '/agents', {
      repo: 'acme/app',
      prompt: 'p',
      tier: 'flash',
    });
    expect(github.tokenRequests.map(r => r.grant_type ?? 'code')).toEqual([
      'code',
      'refresh_token',
    ]);
    expect(github.tokenRequests[1]!.refresh_token).toBe('ghr_issued_1');
    expect([...kube.secrets.values()][0]!.stringData!.GH_TOKEN).toBe(
      'ghu_issued_2',
    );
    const dump = JSON.stringify(await knex('credentials').select());
    expect(dump).not.toMatch(/gh[ur]_issued/);
    expect(logs.text()).not.toMatch(/gh[ur]_issued/);
  });

  it('validates POST /agents', async () => {
    await setCredentials();
    const bad = [
      { prompt: 'p', tier: 'flash' },
      { repo: 'nope', prompt: 'p', tier: 'flash' },
      { repo: 'a/b', prompt: '', tier: 'flash' },
      { repo: 'a/b', prompt: 'p' },
      { repo: 'a/b', prompt: 'p', tier: 'unknown' },
      {
        repo: 'a/b',
        prompt: 'p',
        tier: 'flash',
        harness: 'claude',
        model: 'm',
      },
      { repo: 'a/b', prompt: 'p', harness: 'other', model: 'm' },
      { repo: 'a/b', prompt: 'p', tier: 'flash', branch: '../x' },
    ];
    for (const body of bad) {
      expect([body, (await api('POST', '/agents', body)).status]).toEqual([
        body,
        400,
      ]);
    }
    const explicit = await api('POST', '/agents', {
      repo: 'a/b',
      prompt: 'p',
      harness: 'opencode',
      model: 'opencode-go/x',
      branch: 'feat/x',
    });
    expect(explicit.body).toMatchObject({
      harness: 'opencode',
      model: 'opencode-go/x',
      effort: 'high',
      branch: 'feat/x',
      base: 'main',
    });
  });
});
