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

const serviceHeader = (subject: string) =>
  mockCredentials.service.header({
    onBehalfOf: mockCredentials.service(subject),
    targetPluginId: 'cloud-agents',
  });

function twoQuestionStream(): string[] {
  return recordedStream('opencode-needs-input')
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
}

const databases = TestDatabases.create({ ids: ['SQLITE_3', 'POSTGRES_16'] });

describe.each(databases.eachSupportedId())('cloud-agents on %s', databaseId => {
  let knex: Knex;
  let kube: FakeKube;
  let kubeUrl: string;
  let github: Awaited<ReturnType<typeof startFakeGithub>>;
  let logs: CapturedLogs;
  let backend: TestBackend;
  let baseUrl: string;

  async function start(githubApp = false, podStartTimeoutMs = 120_000) {
    ({ backend, baseUrl } = await startPluginBackend({
      knex,
      kube,
      kubeUrl,
      githubUrl: github.url,
      logs,
      githubApp,
      podStartTimeoutMs,
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
    github.reset();
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

  it('gives the assistant plugin only the Claude Code token first, else the Anthropic API key, and refuses a Claude Code token as a key', async () => {
    const apiKey = 'sk-ant-api03-SECRET-assistant';
    const forAssistant = serviceHeader('plugin:assistant');
    const readCredential = (
      auth: string,
      userEntityRef = 'user:default/alice',
    ) => api('POST', '/service/reasoning-credential', { userEntityRef }, auth);

    expect((await readCredential(forAssistant)).body).toEqual({
      credential: null,
    });
    expect(
      (await api('PUT', '/me/credentials/anthropic', { value: CLAUDE_TOKEN }))
        .status,
    ).toBe(400);
    const put = await api('PUT', '/me/credentials/anthropic', {
      value: apiKey,
    });
    expect(put.status).toBe(200);
    expect((put.body as CredentialsSummary).anthropic.set).toBe(true);
    expect(JSON.stringify(put.body)).not.toContain(apiKey);
    expect(JSON.stringify(await knex('credentials').select())).not.toContain(
      apiKey,
    );
    expect((await readCredential(forAssistant)).body).toEqual({
      credential: { kind: 'api_key', apiKey },
    });

    await api('PUT', '/me/credentials/claude', { value: CLAUDE_TOKEN });
    expect((await readCredential(forAssistant)).body).toEqual({
      credential: { kind: 'claude_code', oauthToken: CLAUDE_TOKEN },
    });
    expect(
      (await readCredential(forAssistant, 'user:default/bob')).body,
    ).toEqual({ credential: null });
    expect((await readCredential(ALICE)).status).toBe(403);
    expect((await readCredential(serviceHeader('plugin:catalog'))).status).toBe(
      403,
    );

    await api('DELETE', '/me/credentials/claude');
    await api('DELETE', '/me/credentials/anthropic');
    expect((await readCredential(forAssistant)).body).toEqual({
      credential: null,
    });
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

  it.each([
    ['POST /apis/batch/v1/namespaces/agents-test/jobs', 'create jobs', false],
    ['PATCH /apis/batch/v1/namespaces/agents-test/jobs/*', 'patch jobs', false],
    ['POST /api/v1/namespaces/agents-test/secrets', 'create secrets', false],
    ['GET /api/v1/namespaces/agents-test/pods', 'list pods', false],
    ['GET /apis/batch/v1/namespaces/agents-test/jobs/*', 'get jobs', true],
    ['GET /api/v1/namespaces/agents-test/events', 'list events', true],
    ['GET /api/v1/namespaces/agents-test/pods/*/log', 'get pods/log', false],
  ])(
    'fails the run and its event stream when Kubernetes refuses %s',
    async (path, operation, missingPod) => {
      await setCredentials();
      if (missingPod) kube.podStartup = 'missing';
      kube.refusals.set(String(path), {
        code: 403,
        message: 'Forbidden by namespace Role',
      });
      const { body: created } = await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'do it',
        tier: 'flash',
      });
      const stream = await readSse(`${baseUrl}/agents/${created.id}/events`, {
        Authorization: ALICE,
      });
      expect(stream.closedByServer).toBe(true);
      const failed = await agentWhen(created.id, a => a.status === 'failed');
      expect(failed.runs[0]?.status).toBe('failed');
      expect(stream.messages.at(-1)?.data.event).toMatchObject({
        type: 'agent.status',
        status: 'failed',
        error: expect.stringContaining(
          `${operation} in namespace agents-test refused (HTTP 403)`,
        ),
      });
      expect(stream.raw).toContain(String(operation));
      expect(kube.jobs.size).toBe(0);
    },
  );

  it('reports a refused Job deletion when stopping a run', async () => {
    await setCredentials();
    kube.script = () => ({
      lines: recordedStream('opencode'),
      holdAt: 1,
      exitCode: 0,
    });
    const { body: created } = await api('POST', '/agents', {
      repo: 'acme/app',
      prompt: 'do it',
      tier: 'flash',
    });
    await agentWhen(created.id, a => a.status === 'running');
    kube.refusals.set('DELETE /apis/batch/v1/namespaces/agents-test/jobs/*', {
      code: 403,
      message: 'cannot delete resource jobs',
    });
    await api('POST', `/agents/${created.id}/stop`);
    const stream = await readSse(`${baseUrl}/agents/${created.id}/events`, {
      Authorization: ALICE,
    });
    expect(stream.closedByServer).toBe(true);
    expect(stream.messages.at(-1)?.data.event).toMatchObject({
      type: 'agent.status',
      status: 'failed',
      error: expect.stringContaining('delete jobs'),
    });
    expect(stream.raw).toContain('cannot delete resource jobs');
  });

  it('reports a refused Job creation with the API rejection in the event stream', async () => {
    await setCredentials();
    const message =
      'Job is invalid: spec.template.spec.containers[0].resources: Invalid value';
    kube.refusals.set('POST /apis/batch/v1/namespaces/agents-test/jobs', {
      code: 422,
      message,
    });
    const { body: created } = await api('POST', '/agents', {
      repo: 'acme/app',
      prompt: 'do it',
      tier: 'flash',
    });
    const stream = await readSse(`${baseUrl}/agents/${created.id}/events`, {
      Authorization: ALICE,
    });
    expect(stream.closedByServer).toBe(true);
    expect(stream.raw).toContain(message);
    expect(stream.messages.at(-1)?.data.event).toMatchObject({
      type: 'agent.status',
      status: 'failed',
      error: expect.stringContaining('create jobs'),
    });
    await agentWhen(created.id, a => a.status === 'failed');
  });

  it('reports FailedCreate admission events before the startup timeout', async () => {
    await setCredentials();
    kube.podStartup = 'missing';
    const { body: created } = await api('POST', '/agents', {
      repo: 'acme/app',
      prompt: 'do it',
      tier: 'flash',
    });
    const job = [...kube.jobs.keys()][0]!;
    const message =
      'maximum memory usage per Container is 2Gi, but limit is 4Gi';
    kube.events.push(
      {
        metadata: {},
        involvedObject: { kind: 'Job', name: 'another-job' },
        reason: 'FailedCreate',
        message: 'unrelated failure',
      },
      {
        metadata: {},
        involvedObject: { kind: 'Job', name: job },
        reason: 'FailedCreate',
        message,
      },
    );
    const stream = await readSse(`${baseUrl}/agents/${created.id}/events`, {
      Authorization: ALICE,
    });
    expect(stream.closedByServer).toBe(true);
    expect(stream.raw).toContain(message);
    expect(stream.raw).not.toContain('unrelated failure');
    expect(stream.messages.at(-1)?.data.event).toMatchObject({
      type: 'agent.status',
      status: 'failed',
      error: expect.stringContaining(message),
    });
    await agentWhen(created.id, a => a.status === 'failed');
    expect(kube.jobs.size).toBe(0);
  });

  it.each(['missing', 'unschedulable'] as const)(
    'fails a %s pod after the startup timeout',
    async startup => {
      await backend.stop();
      await start(false, 150);
      await setCredentials();
      kube.podStartup = startup;
      const { body: created } = await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'do it',
        tier: 'flash',
      });
      const stream = await readSse(`${baseUrl}/agents/${created.id}/events`, {
        Authorization: ALICE,
      });
      expect(stream.closedByServer).toBe(true);
      const failed = await agentWhen(created.id, a => a.status === 'failed');
      const reason =
        startup === 'missing' ? 'no pod was created' : 'Insufficient memory';
      expect(failed.runs[0]?.status).toBe('failed');
      expect(stream.messages.at(-1)?.data.event).toMatchObject({
        type: 'agent.status',
        status: 'failed',
        error: expect.stringContaining(reason),
      });
      expect(stream.raw).toContain(reason);
      expect(kube.jobs.size).toBe(0);
    },
  );

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
      'CLOUD_AGENT_RUN_TOKEN',
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
    const twoQuestions = twoQuestionStream();
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

  it('records a partial reply without run credentials and needs them only to start the run', async () => {
    await setCredentials();
    kube.script = () => ({ lines: twoQuestionStream(), exitCode: 0 });
    const agent = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'p',
        tier: 'flash',
      })
    ).body as Agent;
    await agentWhen(agent.id, a => a.status === 'needs_input');
    await api('DELETE', '/me/credentials/opencode');

    expect(
      (
        await api('POST', `/agents/${agent.id}/reply`, {
          questionId: 'nope',
          answer: 'x',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api('POST', `/agents/${agent.id}/reply`, {
          questionId: 'ask-1',
          answer: 'hello',
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await api('POST', `/agents/${agent.id}/reply`, {
          questionId: 'ask-1',
          answer: 'again',
        })
      ).status,
    ).toBe(409);
    const blocked = await api('POST', `/agents/${agent.id}/reply`, {
      questionId: 'ask-2',
      answer: 'hello.txt',
    });
    expect(blocked).toMatchObject({
      status: 422,
      body: { error: 'missing_credential', harness: 'opencode' },
    });
    expect(
      (await api('GET', `/agents/${agent.id}`)).body.openQuestions.map(
        (q: { questionId: string }) => q.questionId,
      ),
    ).toEqual(['ask-2']);
    expect(kube.jobs.size).toBe(1);

    kube.script = () => ({ lines: recordedStream('opencode'), exitCode: 0 });
    await api('PUT', '/me/credentials/opencode', { value: OPENCODE_KEY });
    expect(
      (
        await api('POST', `/agents/${agent.id}/reply`, {
          questionId: 'ask-2',
          answer: 'hello.txt',
        })
      ).status,
    ).toBe(202);
    const done = await agentWhen(agent.id, a => a.status === 'succeeded');
    expect(done.runs).toHaveLength(2);
  });

  it('lists each agent with its latest tool call or assistant message as activity', async () => {
    await setCredentials();
    const lines = recordedStream('opencode');
    const scripts = [
      { lines: lines.slice(0, 9), exitCode: 0, holdAt: 9 },
      { lines, exitCode: 0 },
    ];
    kube.script = () => scripts.shift()!;
    const running = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'p',
        tier: 'flash',
      })
    ).body as Agent;
    expect(running.activity).toBeNull();
    const done = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'q',
        tier: 'flash',
      })
    ).body as Agent;
    await agentWhen(done.id, a => a.status === 'succeeded');

    const byId = await waitFor(async () => {
      const { body } = await api('GET', '/agents');
      const items = new Map((body as Agent[]).map(a => [a.id, a]));
      return items.get(running.id)?.activity && items.get(done.id)?.activity
        ? items
        : undefined;
    });
    expect(byId.get(running.id)!.activity).toEqual({
      type: 'tool.call',
      name: 'shell',
      kind: 'shell',
      summary: expect.stringMatching(/^git status --short; /),
      ts: JSON.parse(lines[7]!).ts,
    });
    expect(byId.get(done.id)!.activity).toEqual({
      type: 'assistant.message',
      text: 'https://github.com/alaborderie/cloud-agent-runner-sandbox/pull/3',
      ts: JSON.parse(lines[26]!).ts,
    });
    const filtered = (await api('GET', '/agents?status=running'))
      .body as Agent[];
    expect(filtered.find(a => a.id === running.id)?.activity?.type).toBe(
      'tool.call',
    );
  });

  it('streams a follow-up as agent.message before the run it starts', async () => {
    await setCredentials();
    const agent = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'p',
        tier: 'flash',
      })
    ).body as Agent;
    await agentWhen(agent.id, a => a.status === 'succeeded');
    expect(
      (
        await api('POST', `/agents/${agent.id}/messages`, {
          text: 'Also add a README',
        })
      ).status,
    ).toBe(202);
    const done = await agentWhen(
      agent.id,
      a => a.status === 'succeeded' && a.runs.length === 2,
    );

    const { messages } = await readSse(`${baseUrl}/agents/${agent.id}/events`, {
      Authorization: ALICE,
    });
    const at = messages.findIndex(m => m.data.event.type === 'agent.message');
    expect(messages[at]!.data).toMatchObject({
      runId: done.runs[1]!.id,
      event: {
        type: 'agent.message',
        text: 'Also add a README',
        ts: expect.any(String),
      },
    });
    expect(messages[at + 1]!.data.event).toMatchObject({
      type: 'agent.run_started',
      reason: 'message',
      runId: done.runs[1]!.id,
    });
    expect(
      messages.filter(m => m.data.event.type === 'agent.message'),
    ).toHaveLength(1);
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

  async function connectGithub(): Promise<void> {
    const connect = await fetch(`${baseUrl}/me/github/connect`, {
      headers: { Authorization: ALICE, Accept: 'application/json' },
    });
    const { url } = (await connect.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    github.codes.set('code-1', 'alice-gh');
    const callback = await fetch(
      `${baseUrl}/me/github/callback?code=code-1&state=${state}`,
      { redirect: 'manual' },
    );
    expect(callback.headers.get('location')).toBe(
      'http://localhost:3000/cloud-agents/settings?github=connected',
    );
  }

  function runSecrets(): Array<{ ghToken: string; runToken: string }> {
    return [...kube.secrets.values()].map(secret => ({
      ghToken: secret.stringData!.GH_TOKEN!,
      runToken: secret.stringData!.CLOUD_AGENT_RUN_TOKEN!,
    }));
  }

  function fetchRunGithubToken(runToken: string | undefined) {
    return fetch(`${baseUrl}/runner/github-token`, {
      headers: runToken ? { Authorization: `Bearer ${runToken}` } : {},
    });
  }

  it('connects GitHub through the App web flow', async () => {
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
  });

  it('starts a run with the stored GitHub token while it outlasts the run, and refreshes it once GitHub rejects it', async () => {
    await backend.stop();
    await start(true);
    await connectGithub();
    await api('PUT', '/me/credentials/opencode', { value: OPENCODE_KEY });

    await api('POST', '/agents', {
      repo: 'acme/app',
      prompt: 'p',
      tier: 'flash',
    });
    expect(github.tokenRequests.map(r => r.grant_type ?? 'code')).toEqual([
      'code',
    ]);
    expect(runSecrets()[0]!.ghToken).toBe('ghu_issued_1');

    github.logins.delete('ghu_issued_1');
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
    expect(runSecrets()[1]!.ghToken).toBe('ghu_issued_2');

    const dump = JSON.stringify(await knex('credentials').select());
    expect(dump).not.toMatch(/gh[ur]_issued/);
    expect(logs.text()).not.toMatch(/gh[ur]_issued/);
  });

  it('refreshes a token that would expire during the run once for two concurrent run starts, and both runs keep a valid token', async () => {
    await backend.stop();
    await start(true);
    github.expiresIn = 3600;
    await connectGithub();
    await api('PUT', '/me/credentials/opencode', { value: OPENCODE_KEY });
    github.expiresIn = 28800;
    github.tokenDelayMs = 200;
    kube.script = () => ({
      lines: recordedStream('opencode'),
      holdAt: 1,
      exitCode: 0,
    });

    const created = await Promise.all([
      api('POST', '/agents', { repo: 'acme/app', prompt: 'a', tier: 'flash' }),
      api('POST', '/agents', { repo: 'acme/app', prompt: 'b', tier: 'flash' }),
    ]);
    expect(created.map(r => r.status)).toEqual([201, 201]);
    expect(github.tokenRequests.map(r => r.grant_type ?? 'code')).toEqual([
      'code',
      'refresh_token',
    ]);
    const runs = runSecrets();
    expect(runs.map(r => r.ghToken)).toEqual(['ghu_issued_2', 'ghu_issued_2']);
    expect(github.logins.get('ghu_issued_2')).toBe('alice-gh');
    expect(github.logins.has('ghu_issued_1')).toBe(false);

    for (const run of runs) {
      const response = await fetchRunGithubToken(run.runToken);
      expect(response.status).toBe(200);
      const { token } = (await response.json()) as { token: string };
      expect(github.logins.get(token)).toBe('alice-gh');
    }
    expect(github.tokenRequests).toHaveLength(2);
  });

  it('gives a runner pod the current GitHub token only for its active run', async () => {
    await backend.stop();
    await start(true);
    github.expiresIn = 300;
    await connectGithub();
    await api('PUT', '/me/credentials/opencode', { value: OPENCODE_KEY });
    kube.script = () => ({
      lines: recordedStream('opencode'),
      holdAt: 1,
      exitCode: 0,
    });
    const agent = (
      await api('POST', '/agents', {
        repo: 'acme/app',
        prompt: 'p',
        tier: 'flash',
      })
    ).body as Agent;
    const job = [...kube.jobs.values()][0]!;
    expect(job.spec!.template.spec!.containers[0]!.env).toContainEqual({
      name: 'CLOUD_AGENT_GH_TOKEN_URL',
      value: 'http://backstage.test/api/cloud-agents/runner/github-token',
    });
    const { ghToken, runToken } = runSecrets()[0]!;
    expect(ghToken).toBe('ghu_issued_2');
    expect(runToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const fresh = await fetchRunGithubToken(runToken);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('cache-control')).toBe('no-store');
    const { token } = (await fresh.json()) as { token: string };
    expect(token).toBe('ghu_issued_3');
    expect(github.logins.get(token)).toBe('alice-gh');
    expect(github.logins.has(ghToken)).toBe(false);

    const { body: patToken } = await api('POST', '/me/tokens', { name: 'x' });
    for (const wrong of [undefined, 'not-a-run-token', patToken.token]) {
      expect((await fetchRunGithubToken(wrong)).status).toBe(401);
    }

    kube.release(agent.runs[0]!.id);
    await agentWhen(agent.id, a => a.status === 'succeeded');
    expect((await fetchRunGithubToken(runToken)).status).toBe(401);

    const rows = JSON.stringify(await knex('runs').select());
    expect(rows).not.toContain(runToken);
    expect(logs.text()).not.toContain(runToken);
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
