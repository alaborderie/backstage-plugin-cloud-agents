import {
  mockCredentials,
  TestDatabases,
  type TestBackend,
} from '@backstage/backend-test-utils';
import type { V1Job } from '@kubernetes/client-node';
import type { Knex } from 'knex';
import type { Agent } from '@alaborderie/plugin-cloud-agents-common';
import {
  FakeKube,
  recordedStream,
  type PodScript,
} from './__testUtils__/fakeKube';
import {
  CapturedLogs,
  readSse,
  startFakeGithub,
  startPluginBackend,
  waitFor,
} from './__testUtils__/harness';

jest.setTimeout(60_000);

const ALICE = mockCredentials.user.header('user:default/alice');
const OPENCODE_KEY = 'sk-opencode-SECRET-0123456789';
const GITHUB_TOKEN = 'ghu_SECRET_github_token_42';
const REPO = 'acme/app';

/** A run that prints `run.started` and holds until released, then succeeds. */
function held(prUrl: string | null = null): PodScript {
  const lines = recordedStream('opencode').map(line => {
    const event = JSON.parse(line);
    return event.type === 'run.finished'
      ? JSON.stringify({ ...event, pr_url: prUrl })
      : line;
  });
  return { lines, exitCode: 0, holdAt: 2 };
}

function containerOf(job: V1Job) {
  return job.spec!.template.spec!.containers[0]!;
}

function branchOf(job: V1Job): string {
  const args = containerOf(job).args!;
  return args[args.indexOf('--branch') + 1]!;
}

function isHubJob(job: V1Job): boolean {
  return containerOf(job).env!.some(
    e => e.name === 'CLOUD_AGENT_KIND' && e.value === 'hub',
  );
}

const databases = TestDatabases.create({ ids: ['SQLITE_3', 'POSTGRES_16'] });

describe.each(databases.eachSupportedId())('hubs on %s', databaseId => {
  let knex: Knex;
  let kube: FakeKube;
  let github: Awaited<ReturnType<typeof startFakeGithub>>;
  let backend: TestBackend;
  let baseUrl: string;

  async function call(
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

  /** Invokes a `cloud-agents:` action as the pod does, with its run token. */
  function action(name: string, input: unknown, token: string) {
    return call(
      'POST',
      `/.backstage/actions/v1/actions/cloud-agents:${name}/invoke`,
      input,
      `Bearer ${token}`,
    );
  }

  function runSecret(runId: string): Record<string, string> {
    const job = [...kube.jobs.values()].find(
      j => j.metadata?.labels?.['cloud-agents/run-id'] === runId,
    );
    return kube.secrets.get(job!.metadata!.name!)!.stringData!;
  }

  function agentWhen(
    id: string,
    predicate: (a: Agent) => boolean,
  ): Promise<Agent> {
    return waitFor(async () => {
      const { body } = await call('GET', `/agents/${id}`);
      return predicate(body) ? (body as Agent) : undefined;
    });
  }

  async function createHub(): Promise<{ hub: Agent; token: string }> {
    github.logins.set(GITHUB_TOKEN, 'alice-gh');
    await call('PUT', '/me/credentials/opencode', { value: OPENCODE_KEY });
    await call('PUT', '/me/credentials/github', { value: GITHUB_TOKEN });
    const { status, body: hub } = await call('POST', '/agents', {
      repo: REPO,
      prompt: 'Ship a and b',
      tier: 'flash',
      kind: 'hub',
    });
    expect(status).toBe(201);
    return {
      hub,
      token: runSecret(hub.runs[0].id).CLOUD_AGENT_RUN_TOKEN!,
    };
  }

  async function wakeRows(childId: string) {
    return knex('wake_events').where({ child_id: childId });
  }

  beforeAll(async () => {
    knex = await databases.init(databaseId);
    github = await startFakeGithub();
  });

  beforeEach(async () => {
    github.reset();
    kube = new FakeKube();
    const kubeUrl = await kube.start();
    ({ backend, baseUrl } = await startPluginBackend({
      knex,
      kube,
      kubeUrl,
      githubUrl: github.url,
      logs: new CapturedLogs(),
    }));
  });

  afterEach(async () => {
    await backend.stop();
    await kube.stop();
  });

  afterAll(async () => {
    await github.close();
  });

  it('runs a hub: children through actions, queued and batched wakes, no run while waiting, then success', async () => {
    const childA = 'cloud-agent/child-a';
    let childARuns = 0;
    kube.script = job => {
      if (isHubJob(job)) return held();
      if (branchOf(job) === childA) {
        childARuns += 1;
        return childARuns === 1
          ? { lines: recordedStream('opencode-needs-input'), exitCode: 0 }
          : held('https://github.com/acme/app/pull/1');
      }
      return held('https://github.com/acme/app/pull/2');
    };
    const { hub, token: token1 } = await createHub();
    expect(hub).toMatchObject({ kind: 'hub', parentId: null, children: [] });
    expect(token1.startsWith('cahub.')).toBe(true);

    const created = [];
    for (const child of [
      { title: 'Add a', branch: childA },
      { title: 'Add b', branch: 'cloud-agent/child-b' },
    ]) {
      created.push(
        await action(
          'create-agent',
          { repo: REPO, prompt: child.title, tier: 'flash', ...child },
          token1,
        ),
      );
    }
    expect(created.map(c => c.status)).toEqual([200, 200]);
    const [a, b] = created.map(c => c.body.output.agent as Agent);
    expect(a).toMatchObject({ kind: 'task', parentId: hub.id });
    expect(b).toMatchObject({ kind: 'task', parentId: hub.id });

    await agentWhen(a!.id, x => x.status === 'needs_input');
    await new Promise(r => setTimeout(r, 600));
    expect((await agentWhen(hub.id, () => true)).runs).toHaveLength(1);

    const listed = await action('list-agents', {}, token1);
    expect(listed.body.output.agents.map((x: Agent) => x.id).sort()).toEqual(
      [a!.id, b!.id].sort(),
    );
    expect(
      (await action('send-agent-message', { id: b!.id, text: 'x' }, token1))
        .status,
    ).toBe(409);

    expect(
      (
        await call(
          'PUT',
          '/runner/hub/state',
          { state: { plan: ['a', 'b'] } },
          `Bearer ${token1}`,
        )
      ).status,
    ).toBe(200);

    kube.release(hub.runs[0]!.id);
    const second = await agentWhen(hub.id, x => x.runs.length === 2);
    expect(second.status).not.toBe('waiting');
    const run2 = second.runs[1]!.id;
    expect(runSecret(run2)['prompt.md']).toBe(
      [
        'Use the backstage-hub skill.',
        '',
        'Objective:',
        'Ship a and b',
        '',
        'Wake events:',
        `- child ${
          a!.id
        } "Add a" is needs_input: question ask-1 "Should I delete README.md?" options [yes, no]`,
      ].join('\n'),
    );
    expect((await action('list-agents', {}, token1)).status).toBe(403);
    const token2 = runSecret(run2).CLOUD_AGENT_RUN_TOKEN!;
    expect(
      (await call('GET', '/runner/hub/state', undefined, `Bearer ${token2}`))
        .body,
    ).toEqual({ state: { plan: ['a', 'b'] } });

    const read = await action('get-agent', { id: a!.id }, token2);
    expect(read.status).toBe(200);
    expect(read.body.output.agent.openQuestions[0].questionId).toBe('ask-1');
    expect(typeof read.body.output.lastMessage).toBe('string');
    const replied = await action(
      'reply-to-agent',
      { id: a!.id, questionId: 'ask-1', answer: 'no' },
      token2,
    );
    expect(replied.status).toBe(200);
    const aRun2 = (await agentWhen(a!.id, x => x.runs.length === 2)).runs[1]!
      .id;

    kube.release(run2);
    const waiting = await agentWhen(hub.id, x => x.status === 'waiting');
    expect(waiting.runs.every(r => r.status !== 'running')).toBe(true);
    expect(
      [...kube.pods.values()]
        .filter(
          p => p.pod.metadata?.labels?.['cloud-agents/agent-id'] === hub.id,
        )
        .every(p => p.done),
    ).toBe(true);

    kube.release(aRun2);
    kube.release(b!.runs[0]!.id);
    const third = await agentWhen(hub.id, x => x.runs.length === 3);
    await new Promise(r => setTimeout(r, 600));
    expect((await agentWhen(hub.id, () => true)).runs).toHaveLength(3);
    expect(runSecret(third.runs[2]!.id)['prompt.md']).toContain(
      `- child ${
        b!.id
      } "Add b" is succeeded (branch cloud-agent/child-b, PR https://github.com/acme/app/pull/2)`,
    );

    kube.release(third.runs[2]!.id);
    const stream = await readSse(`${baseUrl}/agents/${hub.id}/events`, {
      Authorization: ALICE,
    });
    expect(stream.closedByServer).toBe(true);
    const events = stream.messages.map(m => m.data.event);
    const startOf = (runId: string) =>
      events.findIndex(
        e => e.type === 'agent.run_started' && e.runId === runId,
      );
    const wakesOf = (runId: string) =>
      stream.messages
        .filter(
          m => m.data.runId === runId && m.data.event.type === 'agent.wake',
        )
        .map(m => m.data.event);
    expect(events[startOf(run2)]).toMatchObject({ reason: 'child' });
    expect(wakesOf(run2)).toEqual([
      expect.objectContaining({ childId: a!.id, childStatus: 'needs_input' }),
    ]);
    expect(events[startOf(run2) - 1]?.type).toBe('agent.wake');
    expect(
      wakesOf(third.runs[2]!.id)
        .map(e => e.childId)
        .sort(),
    ).toEqual([a!.id, b!.id].sort());

    const done = await agentWhen(hub.id, x => x.status === 'succeeded');
    expect(done.children).toEqual([
      expect.objectContaining({
        id: a!.id,
        status: 'succeeded',
        prUrl: 'https://github.com/acme/app/pull/1',
        openQuestions: 0,
      }),
      expect.objectContaining({
        id: b!.id,
        status: 'succeeded',
        prUrl: 'https://github.com/acme/app/pull/2',
      }),
    ]);
    const children = await call('GET', `/agents?parentId=${hub.id}`);
    expect(children.body.map((x: Agent) => x.id).sort()).toEqual(
      [a!.id, b!.id].sort(),
    );
  });

  it('limits a hub run token to its own children and a task run token to the GitHub token', async () => {
    kube.script = () => held();
    const { hub, token } = await createHub();
    const { body: other } = await call('POST', '/agents', {
      repo: REPO,
      prompt: 'Unrelated',
      tier: 'flash',
    });
    const taskToken = runSecret(other.runs[0].id).CLOUD_AGENT_RUN_TOKEN!;

    for (const [name, input] of [
      ['get-agent', { id: other.id }],
      ['stop-agent', { id: other.id }],
      ['send-agent-message', { id: other.id, text: 'x' }],
      ['reply-to-agent', { id: other.id, questionId: 'q', answer: 'x' }],
      ['list-agents', { parentId: other.id }],
      ['get-agent', { id: hub.id }],
    ] as const) {
      const refused = await action(name, input, token);
      expect([name, refused.status, refused.body.error.message]).toEqual([
        name,
        403,
        'not_your_child',
      ]);
    }
    expect(
      (
        await action(
          'create-agent',
          { repo: REPO, prompt: 'p', tier: 'flash', kind: 'hub' },
          token,
        )
      ).status,
    ).toBe(400);
    expect(
      (await call('GET', '/agents', undefined, `Bearer ${token}`)).status,
    ).toBe(403);
    expect((await agentWhen(other.id, () => true)).status).not.toBe('stopped');

    expect((await action('list-agents', {}, taskToken)).status).toBe(401);
    expect(
      (await call('GET', '/runner/hub/state', undefined, `Bearer ${taskToken}`))
        .status,
    ).toBe(401);
    expect(
      (
        await call(
          'GET',
          '/runner/github-token',
          undefined,
          `Bearer ${taskToken}`,
        )
      ).status,
    ).toBe(200);

    const asUser = await action('get-agent', { id: other.id }, ALICE.slice(7));
    expect(asUser.status).toBe(200);
    expect(asUser.body.output.agent.id).toBe(other.id);

    const { body: list } = await call('GET', '/.backstage/actions/v1/actions');
    expect(
      list.actions.map(
        (x: { id: string; attributes: { readOnly: boolean } }) => [
          x.id,
          x.attributes.readOnly,
        ],
      ),
    ).toEqual([
      ['cloud-agents:create-agent', false],
      ['cloud-agents:list-agents', true],
      ['cloud-agents:get-agent', true],
      ['cloud-agents:reply-to-agent', false],
      ['cloud-agents:send-agent-message', false],
      ['cloud-agents:stop-agent', false],
    ]);
  });

  it('starts a message run on a waiting hub, and stops hub and children without waking it', async () => {
    kube.script = () => held();
    const { hub, token } = await createHub();
    const { body: c } = await action(
      'create-agent',
      { repo: REPO, prompt: 'Add c', tier: 'flash', title: 'Add c' },
      token,
    );
    kube.release(hub.runs[0]!.id);
    await agentWhen(hub.id, x => x.status === 'waiting');

    expect(
      (await call('POST', `/agents/${hub.id}/messages`, { text: 'Also do d' }))
        .status,
    ).toBe(202);
    const second = await agentWhen(hub.id, x => x.runs.length === 2);
    const run2 = second.runs[1]!.id;
    expect(runSecret(run2)['prompt.md']).toBe(
      'Use the backstage-hub skill.\n\nObjective:\nShip a and b\n\nMessages from the user:\n- Also do d',
    );
    const token2 = runSecret(run2).CLOUD_AGENT_RUN_TOKEN!;
    const stopped = await action(
      'stop-agent',
      { id: c.output.agent.id },
      token2,
    );
    expect(stopped.status).toBe(200);
    await agentWhen(c.output.agent.id, x => x.status === 'stopped');
    expect(await wakeRows(c.output.agent.id)).toHaveLength(0);

    const { body: d } = await action(
      'create-agent',
      { repo: REPO, prompt: 'Add d', tier: 'flash' },
      token2,
    );
    kube.release(run2);
    await agentWhen(hub.id, x => x.status === 'waiting');

    expect((await call('POST', `/agents/${hub.id}/stop`)).status).toBe(202);
    const hubStopped = await agentWhen(hub.id, x => x.status === 'stopped');
    await agentWhen(d.output.agent.id, x => x.status === 'stopped');
    expect(await wakeRows(d.output.agent.id)).toHaveLength(0);
    expect(hubStopped.runs).toHaveLength(2);
  });
});
