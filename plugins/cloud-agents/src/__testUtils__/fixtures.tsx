import { renderInTestApp } from '@backstage/frontend-test-utils';
import type {
  Agent,
  AgentEventEnvelope,
  AgentRun,
  CredentialsSummary,
  PluginEvent,
  RunnerEvent,
} from '@alaborderie/plugin-cloud-agents-common';
import { cloudAgentsApiRef, type CloudAgentsApi } from '../api';
import { CloudAgentsRoot } from '../components/Root';

export const NOW = Date.now();
export const iso = (ms: number) => new Date(ms).toISOString();

const startOfToday = (() => {
  const day = new Date(NOW);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
})();
export const YESTERDAY = startOfToday - 3_600_000;
export const EARLIER = startOfToday - 3 * 86_400_000;

function run(
  id: string,
  status: AgentRun['status'],
  startedAt: number,
): AgentRun {
  const done = status !== 'running';
  return {
    id,
    status,
    startedAt: iso(startedAt),
    finishedAt: done ? iso(startedAt + 120_000) : null,
    exitCode: done ? 0 : null,
  };
}

function agent(overrides: Partial<Agent> & Pick<Agent, 'id' | 'title'>): Agent {
  return {
    repo: 'acme/acme-api',
    base: 'main',
    branch: `cloud-agent/${overrides.id.slice(3)}`,
    harness: 'opencode',
    model: 'opencode-go/deepseek-v4.1-flash',
    effort: 'high',
    status: 'succeeded',
    createdAt: iso(NOW - 600_000),
    updatedAt: iso(NOW),
    runs: [],
    openQuestions: [],
    prUrl: null,
    parent: null,
    activity: null,
    ...overrides,
  };
}

export const succeeded = agent({
  id: 'ag_000000000001',
  title: 'Add a health check endpoint',
  runs: [run('run-1', 'succeeded', NOW - 600_000)],
  prUrl: 'https://github.com/acme/acme-api/pull/7',
});

export const needsYou = agent({
  id: 'ag_000000000002',
  title: 'Pick a greeting',
  repo: 'acme/garden-app',
  status: 'needs_input',
  runs: [run('run-2', 'needs_input', NOW - 300_000)],
  openQuestions: [
    {
      questionId: 'ask-1',
      runId: 'run-2',
      question: 'Which greeting?',
      options: ['hello', 'bonjour'],
    },
    {
      questionId: 'ask-2',
      runId: 'run-2',
      question: 'Which file holds it?',
      options: ['README.md', 'GREETING.md'],
    },
  ],
});

export const running = agent({
  id: 'ag_000000000003',
  title: 'Fix the login redirect',
  repo: 'acme/garden-app',
  status: 'running',
  runs: [run('run-3', 'running', NOW - 375_000)],
  activity: {
    type: 'tool.call',
    name: 'bash',
    kind: 'shell',
    summary: 'yarn test',
    ts: iso(NOW - 5_000),
  },
});

export const queued = agent({
  id: 'ag_000000000004',
  title: 'Bump dependencies',
  status: 'queued',
});

export const failed = agent({
  id: 'ag_000000000005',
  title: 'Migrate the billing job',
  status: 'failed',
  updatedAt: iso(YESTERDAY),
  runs: [run('run-5', 'failed', YESTERDAY - 600_000)],
});

export const stopped = agent({
  id: 'ag_000000000006',
  title: 'Rename the config keys',
  status: 'stopped',
  updatedAt: iso(EARLIER),
  runs: [run('run-6', 'stopped', EARLIER - 600_000)],
});

export const allAgents = [
  succeeded,
  needsYou,
  running,
  queued,
  failed,
  stopped,
];

/** Credentials with every harness and GitHub set, except those named false. */
export function credentials(
  set: Partial<
    Record<'claude' | 'codex' | 'opencode' | 'github', boolean>
  > = {},
): CredentialsSummary {
  const on = (name: keyof typeof set) => set[name] ?? true;
  return {
    claude: { set: on('claude'), updatedAt: null },
    codex: {
      set: on('codex'),
      kind: on('codex') ? 'api_key' : null,
      updatedAt: null,
    },
    opencode: { set: on('opencode'), updatedAt: null },
    github: {
      connected: on('github'),
      login: on('github') ? 'acme-dev' : null,
      method: on('github') ? 'token' : null,
      updatedAt: null,
      connectAvailable: false,
    },
  };
}

export const unset = credentials({
  claude: false,
  codex: false,
  opencode: false,
  github: false,
});

type Event = RunnerEvent | PluginEvent;
type Without<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** A stored event as the stream sends it. Runner events get their envelope fields. */
export function envelope(
  seq: number,
  runId: string,
  event: Without<RunnerEvent, 'v' | 'seq' | 'ts' | 'run_id'> | PluginEvent,
  ts = iso(NOW),
): AgentEventEnvelope {
  const full: Event = event.type.startsWith('agent.')
    ? (event as PluginEvent)
    : ({ v: 1, seq, ts, run_id: runId, ...event } as RunnerEvent);
  return { seq, runId, event: full };
}

export function mockApi(
  overrides: Partial<CloudAgentsApi> = {},
): jest.Mocked<CloudAgentsApi> {
  return {
    listAgents: jest.fn(async () => allAgents),
    getAgent: jest.fn(
      async (id: string) => allAgents.find(a => a.id === id) ?? succeeded,
    ),
    createAgent: jest.fn(async () => succeeded),
    reply: jest.fn(async () => {}),
    message: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    streamEvents: jest.fn(async () => {}),
    getCredentials: jest.fn(async () => credentials()),
    putCredential: jest.fn(async () => credentials()),
    deleteCredential: jest.fn(async () => credentials()),
    githubConnectUrl: jest.fn(
      async () => 'https://github.com/login/oauth/authorize?client_id=acme',
    ),
    listTokens: jest.fn(async () => []),
    createToken: jest.fn(async () => ({
      id: 'tok_1',
      token: 'cat_shown_once',
    })),
    deleteToken: jest.fn(async () => {}),
    ...overrides,
  } as jest.Mocked<CloudAgentsApi>;
}

/** Renders the plugin page at `path`, under `/cloud-agents`. */
export function renderRoot(api: CloudAgentsApi, path: string) {
  return renderInTestApp(<CloudAgentsRoot />, {
    apis: [[cloudAgentsApiRef, api]],
    mountPath: '/cloud-agents/*',
    initialRouteEntries: [path],
  });
}
