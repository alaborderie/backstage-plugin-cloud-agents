import type {
  AccessToken,
  Agent,
  AgentEventEnvelope,
  AgentStatus,
  CreateAgentRequest,
  CreatedAccessToken,
  CredentialName,
  CredentialsSummary,
  PluginEvent,
  PutCredentialRequest,
  RunReason,
  RunnerEvent,
} from '@alaborderie/plugin-cloud-agents-common';
import {
  DEFAULT_TIERS,
  isTerminalAgentStatus,
  summarizeToolInput,
} from '@alaborderie/plugin-cloud-agents-common';
import { CloudAgentsApiError, type CloudAgentsApi } from '../src/api';

/*
 * A fictional backend for the dev app (`?mock`), so every screen can be shown
 * without a cluster. All repositories, people, and events are invented.
 */

type AnyEvent = RunnerEvent | PluginEvent;
type Draft = { type: AnyEvent['type'] } & Record<string, unknown>;

const OWNER = 'acme';
const iso = (ms: number) => new Date(ms).toISOString();
const minutesAgo = (m: number) => Date.now() - m * 60_000;
const later = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha = (seed: string) =>
  Array.from({ length: 40 }, (_, i) =>
    '0123456789abcdef'.charAt(
      (seed.charCodeAt(i % seed.length) * (i + 7)) % 16,
    ),
  ).join('');

interface MockAgent {
  agent: Agent;
  events: AgentEventEnvelope[];
  listeners: Set<(e: AgentEventEnvelope) => void>;
  runnerSeq: number;
  live?: () => void;
}

const tierOf = (name: string) =>
  DEFAULT_TIERS.find(t => t.name === name) ?? DEFAULT_TIERS[0]!;

export class MockCloudAgentsApi implements CloudAgentsApi {
  private readonly agents = new Map<string, MockAgent>();
  private credentials: CredentialsSummary = {
    claude: { set: true, updatedAt: iso(minutesAgo(60 * 24 * 23)) },
    codex: {
      set: true,
      kind: 'auth_json',
      updatedAt: iso(minutesAgo(60 * 24 * 7)),
    },
    opencode: { set: false, updatedAt: null },
    github: {
      connected: true,
      login: 'octo-dev',
      method: 'oauth',
      updatedAt: iso(minutesAgo(60 * 24 * 3)),
      connectAvailable: true,
    },
  };
  private tokens: AccessToken[] = [
    {
      id: 'tok_demo1',
      name: 'T3 bridge on the workstation',
      createdAt: iso(minutesAgo(60 * 24 * 14)),
      lastUsedAt: iso(minutesAgo(18)),
    },
    {
      id: 'tok_demo2',
      name: 'Laptop CLI',
      createdAt: iso(minutesAgo(60 * 24 * 35)),
      lastUsedAt: null,
    },
  ];

  constructor() {
    this.seed();
  }

  /* ----- fixtures ----- */

  private add(
    partial: Pick<Agent, 'id' | 'title' | 'repo' | 'status'> & {
      kind?: Agent['kind'];
      parentId?: string;
      tier: string;
      createdMin: number;
      runs?: Array<{
        status: Agent['runs'][number]['status'];
        start: number;
        end?: number;
        exit?: number;
      }>;
      prUrl?: string;
      openQuestions?: Agent['openQuestions'];
      parent?: Agent['parent'];
    },
  ): MockAgent {
    const tier = tierOf(partial.tier);
    const runs = (partial.runs ?? []).map((r, i) => ({
      id: `${partial.id}-run-${i + 1}`,
      status: r.status,
      startedAt: iso(minutesAgo(r.start)),
      finishedAt: r.end === undefined ? null : iso(minutesAgo(r.end)),
      exitCode: r.exit ?? null,
    }));
    const last = runs[runs.length - 1];
    const agent: Agent = {
      id: partial.id,
      kind: partial.kind ?? 'task',
      title: partial.title,
      repo: partial.repo,
      base: 'main',
      branch: `cloud-agent/${partial.id.slice(3)}4e2a`,
      harness: tier.harness,
      model: tier.model,
      effort: tier.effort,
      status: partial.status,
      createdAt: iso(minutesAgo(partial.createdMin)),
      updatedAt:
        last?.finishedAt ??
        last?.startedAt ??
        iso(minutesAgo(partial.createdMin)),
      runs,
      openQuestions: partial.openQuestions ?? [],
      prUrl: partial.prUrl ?? null,
      parent: partial.parent ?? null,
      parentId: partial.parentId ?? null,
      children: [],
      activity: null,
    };
    const mock: MockAgent = {
      agent,
      events: [],
      listeners: new Set(),
      runnerSeq: 0,
    };
    this.agents.set(agent.id, mock);
    return mock;
  }

  private push(
    mock: MockAgent,
    event: Draft,
    runIndex = mock.agent.runs.length - 1,
    ts = Date.now(),
  ) {
    const run = mock.agent.runs[runIndex];
    const runId = run?.id ?? `${mock.agent.id}-run-0`;
    const plugin = event.type.startsWith('agent.');
    const full = (plugin
      ? { ts: iso(ts), ...event }
      : {
          v: 1,
          seq: mock.runnerSeq++,
          ts: iso(ts),
          run_id: runId,
          ...event,
        }) as unknown as AnyEvent;
    const envelope: AgentEventEnvelope = {
      seq: mock.events.length + 1,
      runId,
      event: full,
    };
    mock.events.push(envelope);
    if (full.type === 'tool.call') {
      mock.agent.activity = {
        type: 'tool.call',
        name: full.name,
        kind: full.kind,
        summary: summarizeToolInput(full.input),
        ts: full.ts,
      };
    } else if (full.type === 'assistant.message') {
      mock.agent.activity = {
        type: 'assistant.message',
        text: full.text.split('\n')[0] ?? '',
        ts: full.ts,
      };
    }
    mock.listeners.forEach(l => l(envelope));
  }

  private setup(
    mock: MockAgent,
    runIndex: number,
    start: number,
    existed: boolean,
    reason: RunReason,
  ) {
    const run = mock.agent.runs[runIndex]!;
    const a = mock.agent;
    this.push(
      mock,
      { type: 'agent.run_started', runId: run.id, reason },
      runIndex,
      start,
    );
    this.push(
      mock,
      {
        type: 'run.started',
        harness: a.harness,
        model: a.model,
        effort: a.effort,
        repo: a.repo,
        base: a.base,
        branch: a.branch,
        runner_version: '0.4.2+demo',
        harness_version: `${a.harness} 1.0.0`,
      },
      runIndex,
      start + 2_000,
    );
    this.push(
      mock,
      {
        type: 'skills.ready',
        source: 'github.com/acme/agent-skills',
        commit: sha(`${a.id}skills`),
      },
      runIndex,
      start + 6_000,
    );
    this.push(
      mock,
      {
        type: 'workspace.ready',
        repo: a.repo,
        branch: a.branch,
        base: a.base,
        head_sha: sha(`${a.id}${runIndex}`),
        branch_existed: existed,
      },
      runIndex,
      start + 9_000,
    );
    this.push(
      mock,
      {
        type: 'session.started',
        session_id: `sess_${a.id.slice(3)}${runIndex}`,
        model: a.harness === 'claude' ? a.model : null,
      },
      runIndex,
      start + 11_000,
    );
  }

  private tool(
    mock: MockAgent,
    runIndex: number,
    ts: number,
    kind: string,
    name: string,
    input: unknown,
    output: string,
    isError = false,
    ms = 1_500,
  ) {
    const callId = `call_${mock.events.length + 1}`;
    this.push(
      mock,
      {
        type: 'tool.call',
        call_id: callId,
        name,
        kind,
        input,
        parent_call_id: null,
      },
      runIndex,
      ts,
    );
    this.push(
      mock,
      {
        type: 'tool.result',
        call_id: callId,
        is_error: isError,
        output,
        truncated: false,
        parent_call_id: null,
      },
      runIndex,
      ts + ms,
    );
  }

  private say(mock: MockAgent, runIndex: number, ts: number, text: string) {
    this.push(
      mock,
      { type: 'assistant.message', text, parent_call_id: null },
      runIndex,
      ts,
    );
  }

  private finish(
    mock: MockAgent,
    runIndex: number,
    ts: number,
    start: number,
    status: 'succeeded' | 'failed' | 'needs_input' | 'cancelled',
    extra: {
      pr?: string | null;
      error?: string;
      questions?: string[];
      cost?: number | null;
      /** A hub's run ends with the hub waiting while its children work. */
      agentStatus?: AgentStatus;
    } = {},
  ) {
    const exit = { succeeded: 0, failed: 1, needs_input: 3, cancelled: 130 }[
      status
    ];
    const usage = {
      input_tokens: 182_400,
      output_tokens: 9_800,
      cached_input_tokens: 151_000,
      reasoning_tokens: 0,
      cost_usd: extra.cost === undefined ? 1.24 : extra.cost,
    };
    this.push(mock, { ...usage, type: 'usage' }, runIndex, ts - 500);
    this.push(
      mock,
      {
        type: 'run.finished',
        status,
        exit_code: exit,
        harness_exit_code: status === 'cancelled' ? null : exit,
        branch: mock.agent.branch,
        head_sha:
          status === 'cancelled' ? null : sha(`${mock.agent.id}end${runIndex}`),
        pushed: status !== 'cancelled',
        pr_url: extra.pr ?? null,
        open_questions: extra.questions ?? [],
        usage,
        duration_ms: ts - start,
        error: extra.error ?? null,
      },
      runIndex,
      ts,
    );
    const agentStatus: AgentStatus =
      extra.agentStatus ?? (status === 'cancelled' ? 'stopped' : status);
    this.push(
      mock,
      { type: 'agent.status', status: agentStatus },
      runIndex,
      ts + 200,
    );
  }

  private seed() {
    const live = this.add({
      id: 'ag_7k2m9x',
      title: 'Redesign the checkout summary',
      repo: `${OWNER}/garden-app`,
      status: 'running',
      tier: 'opus',
      createdMin: 26,
      runs: [
        { status: 'succeeded', start: 26, end: 13, exit: 0 },
        { status: 'running', start: 6.2 },
      ],
      prUrl: `https://github.com/${OWNER}/garden-app/pull/41`,
      parent: { source: 't3', label: 'Checkout polish' },
    });
    const r1 = minutesAgo(26);
    this.setup(live, 0, r1, false, 'initial');
    this.say(
      live,
      0,
      r1 + 20_000,
      'I’ll read the current `CheckoutSummary` and `CartTotals` components first, so the redesign covers every state.',
    );
    this.tool(
      live,
      0,
      r1 + 25_000,
      'read',
      'Read',
      { file_path: 'src/checkout/CheckoutSummary.tsx' },
      '     1\timport { CartTotals } from "./CartTotals";\n…188 lines',
      false,
      400,
    );
    this.tool(
      live,
      0,
      r1 + 27_000,
      'read',
      'Read',
      { file_path: 'src/checkout/CartTotals.tsx' },
      '…96 lines',
      false,
      300,
    );
    this.tool(
      live,
      0,
      r1 + 29_000,
      'read',
      'Read',
      { file_path: 'src/checkout/checkout.css' },
      '…140 lines',
      false,
      300,
    );
    this.tool(
      live,
      0,
      r1 + 31_000,
      'search',
      'Grep',
      { pattern: 'formatPrice' },
      'src/money.ts:12\nsrc/checkout/CartTotals.tsx:31',
      false,
      300,
    );
    this.tool(
      live,
      0,
      r1 + 60_000,
      'edit',
      'Edit',
      { file_path: 'src/checkout/CheckoutSummary.tsx' },
      'Applied 6 edits (+214 −131)',
      false,
      900,
    );
    this.tool(
      live,
      0,
      r1 + 300_000,
      'shell',
      'Bash',
      { command: 'npm run typecheck' },
      'Done in 18.42s.',
      false,
      18_000,
    );
    this.tool(
      live,
      0,
      r1 + 330_000,
      'shell',
      'Bash',
      { command: 'npm test -- --watch=false' },
      'Test Suites: 9 passed, 9 total\nTests:       41 passed, 41 total',
      false,
      22_000,
    );
    this.say(
      live,
      0,
      r1 + 700_000,
      'The summary groups items, discounts, and shipping now. Opening the pull request.',
    );
    this.tool(
      live,
      0,
      r1 + 710_000,
      'shell',
      'Bash',
      { command: 'gh pr create --fill --base main' },
      `https://github.com/${OWNER}/garden-app/pull/41`,
      false,
      3_000,
    );
    this.finish(live, 0, minutesAgo(13), r1, 'succeeded', {
      pr: live.agent.prUrl,
      cost: 2.84,
    });
    const r2 = minutesAgo(6.2);
    this.push(
      live,
      {
        type: 'agent.message',
        text: 'Nice. Now show the delivery estimate under the total, and keep it readable on phones.',
      },
      1,
      r2 - 1_000,
    );
    this.setup(live, 1, r2, true, 'message');
    this.say(
      live,
      1,
      r2 + 22_000,
      'The estimate comes from `useDeliveryWindow`. I’ll render it under the total with a compact layout under 400px.',
    );
    this.tool(
      live,
      1,
      r2 + 28_000,
      'read',
      'Read',
      { file_path: 'src/delivery/useDeliveryWindow.ts' },
      '…64 lines',
      false,
      300,
    );
    this.tool(
      live,
      1,
      r2 + 30_000,
      'read',
      'Read',
      { file_path: 'src/checkout/CheckoutSummary.tsx' },
      '…201 lines',
      false,
      300,
    );
    live.live = () => this.playLive(live);

    const ask = this.add({
      id: 'ag_q4n8d2',
      title: 'Add CSV export to the reports page',
      repo: `${OWNER}/acme-api`,
      status: 'needs_input',
      tier: 'sol',
      createdMin: 31,
      runs: [{ status: 'needs_input', start: 31, end: 9, exit: 3 }],
    });
    const q1 = {
      questionId: 'ask-1',
      runId: 'ag_q4n8d2-run-1',
      question:
        'Should the export include archived reports? There are about 40,000 of them.',
      options: ['Only active reports', 'Active and archived reports'],
    };
    const q2 = {
      questionId: 'ask-2',
      runId: 'ag_q4n8d2-run-1',
      question: 'Which delimiter should the CSV use?',
      options: ['Comma', 'Semicolon'],
    };
    ask.agent.openQuestions = [q1, q2];
    const a1 = minutesAgo(31);
    this.setup(ask, 0, a1, false, 'initial');
    this.say(
      ask,
      0,
      a1 + 20_000,
      'Issue #12 asks for a CSV export on the reports page. I’ll check how reports are queried today.',
    );
    this.tool(
      ask,
      0,
      a1 + 24_000,
      'search',
      'shell',
      { command: ['rg', '-n', 'list_reports', 'src/'] },
      'src/reports/query.py:41:    def list_reports(self, owner, archived=False):',
      false,
      500,
    );
    this.tool(
      ask,
      0,
      a1 + 40_000,
      'shell',
      'shell',
      {
        command: ['python', '-m', 'scripts.count_reports'],
      },
      'active: 3,112 reports, archived: 40,388 reports',
      false,
      6_000,
    );
    this.push(
      ask,
      {
        type: 'question',
        question_id: 'ask-1',
        question: q1.question,
        options: [
          {
            label: q1.options[0],
            description: 'Matches the issue. Fast for every account.',
          },
          {
            label: q1.options[1],
            description: 'Complete, but large accounts wait a few seconds.',
          },
        ],
        blocking: true,
        source: 'ask_user',
      },
      0,
      a1 + 60_000,
    );
    this.push(
      ask,
      {
        type: 'question',
        question_id: 'ask-2',
        question: q2.question,
        options: [
          {
            label: q2.options[0],
            description: 'The default most spreadsheet apps expect.',
          },
          {
            label: q2.options[1],
            description:
              'Opens cleanly in spreadsheets set to European locales.',
          },
        ],
        blocking: true,
        source: 'ask_user',
      },
      0,
      a1 + 62_000,
    );
    this.say(
      ask,
      0,
      a1 + 70_000,
      'I pushed the export behind a feature flag. I’m stopping here until you choose the scope and the delimiter.',
    );
    this.finish(ask, 0, minutesAgo(9), a1, 'needs_input', {
      questions: ['ask-1', 'ask-2'],
      cost: null,
    });

    this.add({
      id: 'ag_3c1f5e',
      title: 'Fix the currency rounding on refunds',
      repo: `${OWNER}/billing-service`,
      status: 'queued',
      tier: 'flash',
      createdMin: 1,
    });

    const failed = this.add({
      id: 'ag_9e2a11',
      title: 'Upgrade the image library and fix the thumbnails',
      repo: `${OWNER}/acme-api`,
      status: 'failed',
      tier: 'flash',
      createdMin: 220,
      runs: [{ status: 'failed', start: 220, end: 214, exit: 1 }],
    });
    const f1 = minutesAgo(220);
    this.setup(failed, 0, f1, false, 'initial');
    this.say(
      failed,
      0,
      f1 + 20_000,
      'Upgrading `imagekit` and regenerating the thumbnail fixtures.',
    );
    this.tool(
      failed,
      0,
      f1 + 30_000,
      'edit',
      'write',
      { filePath: 'package.json' },
      'Wrote 1 file',
      false,
      400,
    );
    this.push(
      failed,
      {
        type: 'rate_limit',
        status: 'limited',
        window: 'five_hour',
        resets_at: iso(minutesAgo(40)),
        utilization: 1,
        message: 'Usage limit reached for the five_hour window.',
      },
      0,
      f1 + 200_000,
    );
    this.push(
      failed,
      {
        type: 'log',
        level: 'error',
        source: 'harness',
        message: 'error: 429 Too Many Requests: usage limit reached',
      },
      0,
      f1 + 201_000,
    );
    this.finish(failed, 0, minutesAgo(214), f1, 'failed', {
      error:
        'The harness reported an error: usage limit reached for the five_hour window.',
    });

    this.seedHub();

    const done = (
      id: string,
      title: string,
      repo: string,
      tier: string,
      start: number,
      end: number,
      pr?: number,
      status: 'succeeded' | 'stopped' = 'succeeded',
    ) => {
      const m = this.add({
        id,
        title,
        repo: `${OWNER}/${repo}`,
        status,
        tier,
        createdMin: start,
        runs: [{ status, start, end, exit: status === 'stopped' ? 130 : 0 }],
        ...(pr && { prUrl: `https://github.com/${OWNER}/${repo}/pull/${pr}` }),
      });
      const t = minutesAgo(start);
      this.setup(m, 0, t, false, 'initial');
      this.say(
        m,
        0,
        t + 20_000,
        status === 'stopped'
          ? 'Starting with the indexer’s batch size.'
          : `Working on “${title}”.`,
      );
      if (status === 'stopped')
        this.finish(m, 0, minutesAgo(end), t, 'cancelled', {
          error: 'Stopped by octo-dev.',
          cost: null,
        });
      else
        this.finish(m, 0, minutesAgo(end), t, 'succeeded', {
          pr: m.agent.prUrl,
        });
    };
    done(
      'ag_b81d07',
      'Add pagination to the orders endpoint',
      'docs-site',
      'sol',
      160,
      138,
      68,
    );
    done(
      'ag_0c4e2f',
      'Add dark mode to the invoice PDF',
      'design-system',
      'opus',
      60 * 50,
      60 * 49,
      75,
    );
    done(
      'ag_5d7b30',
      'Speed up the search index rebuild',
      'garden-app',
      'sol',
      60 * 27,
      60 * 26.8,
      undefined,
      'stopped',
    );
    done(
      'ag_f9c535',
      'Retry webhook deliveries with backoff',
      'billing-service',
      'opus',
      60 * 30,
      60 * 29.2,
      14,
    );
  }

  /** A hub on acme-api, waiting on one child that asks and one that is done. */
  private seedHub() {
    const hub = this.add({
      id: 'ag_h8b3w1',
      kind: 'hub',
      title: 'Ship the v2 invoices API',
      repo: `${OWNER}/acme-api`,
      status: 'waiting',
      tier: 'opus',
      createdMin: 48,
      runs: [
        { status: 'succeeded', start: 48, end: 44, exit: 0 },
        { status: 'succeeded', start: 17, end: 16, exit: 0 },
      ],
    });
    const schema = this.add({
      id: 'ag_c2r7p4',
      parentId: hub.agent.id,
      title: 'Add the v2 invoice schema and migration',
      repo: `${OWNER}/acme-api`,
      status: 'succeeded',
      tier: 'sol',
      createdMin: 45,
      runs: [{ status: 'succeeded', start: 45, end: 17, exit: 0 }],
      prUrl: `https://github.com/${OWNER}/acme-api/pull/88`,
    });
    const endpoints = this.add({
      id: 'ag_c5k1z9',
      parentId: hub.agent.id,
      title: 'Serve GET /v2/invoices with cursor pagination',
      repo: `${OWNER}/acme-api`,
      status: 'needs_input',
      tier: 'sol',
      createdMin: 44.5,
      runs: [{ status: 'needs_input', start: 44.5, end: 11, exit: 3 }],
    });
    const question = {
      questionId: 'ask-1',
      runId: `${endpoints.agent.id}-run-1`,
      question: 'Should a cursor expire after 24 hours, or never?',
      options: ['Expire after 24 hours', 'Never expire'],
    };
    endpoints.agent.openQuestions = [question];

    const h1 = minutesAgo(48);
    this.setup(hub, 0, h1, false, 'initial');
    this.say(
      hub,
      0,
      h1 + 20_000,
      'Two independent tasks: the schema with its migration, then the endpoint on top of it. Starting one agent for each.',
    );
    this.tool(
      hub,
      0,
      h1 + 120_000,
      'shell',
      'Bash',
      { command: 'cloud-agents start --tier sol "Add the v2 invoice schema"' },
      schema.agent.id,
      false,
      2_000,
    );
    this.tool(
      hub,
      0,
      h1 + 150_000,
      'shell',
      'Bash',
      { command: 'cloud-agents start --tier sol "Serve GET /v2/invoices"' },
      endpoints.agent.id,
      false,
      2_000,
    );
    this.finish(hub, 0, minutesAgo(44), h1, 'succeeded', {
      cost: 0.41,
      agentStatus: 'waiting',
    });
    const h2 = minutesAgo(17);
    this.push(
      hub,
      {
        type: 'agent.wake',
        childId: schema.agent.id,
        childStatus: 'succeeded',
      },
      1,
      h2 - 1_000,
    );
    this.setup(hub, 1, h2, true, 'child');
    this.say(
      hub,
      1,
      h2 + 20_000,
      'The schema landed in pull request #88. The endpoint agent is still working, so I’m going back to sleep.',
    );
    this.finish(hub, 1, minutesAgo(16), h2, 'succeeded', {
      cost: 0.18,
      agentStatus: 'waiting',
    });

    const s1 = minutesAgo(45);
    this.setup(schema, 0, s1, false, 'initial');
    this.say(
      schema,
      0,
      s1 + 20_000,
      'Adding `invoices_v2` with a backfill migration.',
    );
    this.finish(schema, 0, minutesAgo(17), s1, 'succeeded', {
      pr: schema.agent.prUrl,
    });

    const e1 = minutesAgo(44.5);
    this.setup(endpoints, 0, e1, false, 'initial');
    this.push(
      endpoints,
      {
        type: 'question',
        question_id: question.questionId,
        question: question.question,
        options: [
          {
            label: question.options[0],
            description: 'Old cursors fail with 410 and clients restart.',
          },
          {
            label: question.options[1],
            description: 'Simpler for clients; cursors encode the sort key.',
          },
        ],
        blocking: true,
        source: 'ask_user',
      },
      0,
      e1 + 90_000,
    );
    this.finish(endpoints, 0, minutesAgo(11), e1, 'needs_input', {
      questions: [question.questionId],
    });
  }

  /** The rest of the running agent's second run, streamed as it would be. */
  private async playLive(mock: MockAgent) {
    const steps: Array<[number, () => void]> = [];
    const tool = (
      kind: string,
      name: string,
      input: unknown,
      output: string,
      isError = false,
      ms = 1_600,
    ) => {
      const callId = `call_live_${steps.length}`;
      steps.push([
        1_100,
        () =>
          this.push(mock, {
            type: 'tool.call',
            call_id: callId,
            name,
            kind,
            input,
            parent_call_id: null,
          }),
      ]);
      steps.push([
        ms,
        () =>
          this.push(mock, {
            type: 'tool.result',
            call_id: callId,
            is_error: isError,
            output,
            truncated: false,
            parent_call_id: null,
          }),
      ]);
    };
    const say = (text: string) =>
      steps.push([
        1_400,
        () =>
          this.push(mock, {
            type: 'assistant.message',
            text,
            parent_call_id: null,
          }),
      ]);
    tool(
      'edit',
      'Write',
      { file_path: 'src/checkout/DeliveryEstimate.tsx' },
      'Created file (86 lines)',
      false,
      900,
    );
    tool(
      'shell',
      'Bash',
      { command: 'npm run typecheck' },
      "src/checkout/DeliveryEstimate.tsx(31,7): error TS2322: Type 'string' is not assignable to type 'DeliveryWindow'.\nFound 1 error in src/checkout/DeliveryEstimate.tsx:31",
      true,
      2_600,
    );
    say(
      '`useDeliveryWindow` returns a window object, not a string. Formatting it with the shared `formatWindow` helper.',
    );
    tool(
      'edit',
      'Edit',
      { file_path: 'src/checkout/DeliveryEstimate.tsx' },
      'Applied 2 edits (+11 −4)',
      false,
      700,
    );
    tool(
      'shell',
      'Bash',
      { command: 'npm run typecheck' },
      'Done in 17.90s.',
      false,
      2_400,
    );
    steps.push([
      900,
      () =>
        this.push(mock, {
          type: 'rate_limit',
          status: 'warning',
          window: 'five_hour',
          resets_at: iso(Date.now() + 95 * 60_000),
          utilization: 0.82,
          message: null,
        }),
    ]);
    tool(
      'shell',
      'Bash',
      { command: 'npm test -- DeliveryEstimate' },
      'PASS src/checkout/DeliveryEstimate.test.tsx\n  ✓ shows the window under the total (41 ms)\n  ✓ wraps on narrow screens (18 ms)\nTests: 2 passed, 2 total',
      false,
      2_600,
    );
    say(
      'The estimate is in. Pushing to the same branch, so pull request #41 picks it up.',
    );
    tool(
      'shell',
      'Bash',
      { command: `git push origin ${mock.agent.branch}` },
      `To github.com:${OWNER}/garden-app.git\n   b7c2e91..d41f0a8  ${mock.agent.branch} -> ${mock.agent.branch}`,
      false,
      1_500,
    );
    steps.push([
      900,
      () => {
        const run = mock.agent.runs[1]!;
        run.status = 'succeeded';
        run.finishedAt = iso(Date.now());
        run.exitCode = 0;
        mock.agent.status = 'succeeded';
        mock.agent.updatedAt = run.finishedAt;
        this.finish(
          mock,
          1,
          Date.now(),
          Date.parse(run.startedAt),
          'succeeded',
          { pr: mock.agent.prUrl, cost: 1.12 },
        );
      },
    ]);
    for (const [wait, step] of steps) {
      await later(wait);
      step();
    }
  }

  private mock(id: string): MockAgent {
    const mock = this.agents.get(id);
    if (!mock)
      throw new CloudAgentsApiError(404, {
        error: { name: 'NotFoundError', message: `No agent ${id}` },
      });
    return mock;
  }

  private startRun(mock: MockAgent, reason: RunReason, text?: string) {
    const a = mock.agent;
    const index = a.runs.length;
    a.runs.push({
      id: `${a.id}-run-${index + 1}`,
      status: 'running',
      startedAt: iso(Date.now()),
      finishedAt: null,
      exitCode: null,
    });
    a.openQuestions = [];
    if (text) this.push(mock, { type: 'agent.message', text }, index);
    a.status = 'queued';
    this.push(mock, { type: 'agent.status', status: 'queued' }, index);
    (async () => {
      await later(1_500);
      this.setup(mock, index, Date.now(), reason !== 'initial', reason);
      a.status = 'running';
      this.push(mock, { type: 'agent.status', status: 'running' }, index);
      await later(1_200);
      const opening: Record<RunReason, string> = {
        child: 'A child reported back. Checking where the objective stands.',
        reply: 'Thanks. Going with your answers.',
        message: 'On it. Reading the last commits first.',
        initial: `Reading the repository to plan “${a.title}”.`,
      };
      this.say(mock, index, Date.now(), opening[reason]);
      await later(1_000);
      this.tool(
        mock,
        index,
        Date.now(),
        'read',
        'shell',
        { command: ['git', 'log', '--oneline', '-5'] },
        'd41f0a8 feat: delivery estimate\nb7c2e91 feat: checkout summary',
        false,
        700,
      );
    })();
  }

  /** The agent as the API returns it, with a hub's children summarized. */
  private view(mock: MockAgent): Agent {
    const agent = structuredClone(mock.agent);
    agent.children = [...this.agents.values()]
      .map(m => m.agent)
      .filter(child => child.parentId === agent.id)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map(child => ({
        id: child.id,
        title: child.title,
        status: child.status,
        branch: child.branch,
        prUrl: child.prUrl,
        openQuestions: child.openQuestions.length,
        updatedAt: child.updatedAt,
      }));
    return agent;
  }

  /* ----- CloudAgentsApi ----- */

  async listAgents(status?: AgentStatus): Promise<Agent[]> {
    await later(250);
    return [...this.agents.values()]
      .map(m => this.view(m))
      .filter(a => !status || a.status === status)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async getAgent(id: string): Promise<Agent> {
    await later(150);
    return this.view(this.mock(id));
  }

  async createAgent(request: CreateAgentRequest): Promise<Agent> {
    await later(600);
    const harness = request.harness ?? tierOf(request.tier ?? 'flash').harness;
    if (!this.credentials[harness].set) {
      throw new CloudAgentsApiError(422, {
        error: 'missing_credential',
        harness,
        credential: harness,
      });
    }
    const id = `ag_${Math.random().toString(36).slice(2, 8)}`;
    const mock = this.add({
      id,
      kind: request.kind,
      title: request.title || request.prompt.split('\n')[0]!.slice(0, 80),
      repo: request.repo,
      status: 'queued',
      tier: request.tier ?? 'opus',
      createdMin: 0,
    });
    this.startRun(mock, 'initial');
    return this.view(mock);
  }

  async reply(id: string, questionId: string): Promise<void> {
    await later(400);
    const mock = this.mock(id);
    const remaining = mock.agent.openQuestions.filter(
      q => q.questionId !== questionId,
    );
    mock.agent.openQuestions = remaining;
    if (!remaining.length) this.startRun(mock, 'reply');
  }

  async message(id: string, text: string): Promise<void> {
    await later(400);
    const mock = this.mock(id);
    if (
      mock.agent.status !== 'waiting' &&
      !isTerminalAgentStatus(mock.agent.status)
    ) {
      throw new CloudAgentsApiError(409, {
        error: {
          name: 'ConflictError',
          message: 'The agent has an active run',
        },
      });
    }
    this.startRun(mock, 'message', text);
  }

  async stop(id: string): Promise<void> {
    await later(500);
    const mock = this.mock(id);
    if (isTerminalAgentStatus(mock.agent.status)) return;
    for (const child of this.agents.values()) {
      if (child.agent.parentId === id) await this.stop(child.agent.id);
    }
    if (mock.agent.status === 'waiting') {
      mock.agent.status = 'stopped';
      this.push(mock, { type: 'agent.status', status: 'stopped' });
      return;
    }
    const index = mock.agent.runs.length - 1;
    const run = mock.agent.runs[index]!;
    run.status = 'stopped';
    run.finishedAt = iso(Date.now());
    run.exitCode = 130;
    mock.agent.status = 'stopped';
    mock.live = undefined;
    this.finish(
      mock,
      index,
      Date.now(),
      Date.parse(run.startedAt),
      'cancelled',
      { error: 'Stopped by octo-dev.', cost: null },
    );
  }

  async streamEvents(
    id: string,
    after: number,
    onEvent: (e: AgentEventEnvelope) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const mock = this.mock(id);
    await later(120);
    const replayed = mock.events.filter(e => e.seq > after);
    replayed.forEach(onEvent);
    if (isTerminalAgentStatus(mock.agent.status)) return;
    await new Promise<void>(resolve => {
      const listeners = mock.listeners;
      function done() {
        listeners.delete(listener);
        resolve();
      }
      function listener(envelope: AgentEventEnvelope) {
        onEvent(envelope);
        if (
          envelope.event.type === 'agent.status' &&
          isTerminalAgentStatus(envelope.event.status)
        )
          done();
      }
      mock.listeners.add(listener);
      signal.addEventListener('abort', done);
      if (mock.live) {
        const play = mock.live;
        mock.live = undefined;
        setTimeout(play, 1_500);
      }
    });
  }

  async getCredentials(): Promise<CredentialsSummary> {
    await later(200);
    return structuredClone(this.credentials);
  }

  async putCredential(
    name: CredentialName,
    request: PutCredentialRequest,
  ): Promise<CredentialsSummary> {
    await later(500);
    const now = iso(Date.now());
    if (name === 'github')
      this.credentials.github = {
        ...this.credentials.github,
        connected: true,
        login: 'octo-dev',
        method: 'token',
        updatedAt: now,
      };
    else if (name === 'codex')
      this.credentials.codex = {
        set: true,
        kind: request.kind ?? 'api_key',
        updatedAt: now,
      };
    else this.credentials[name] = { set: true, updatedAt: now };
    return structuredClone(this.credentials);
  }

  async deleteCredential(name: CredentialName): Promise<CredentialsSummary> {
    await later(400);
    if (name === 'github')
      this.credentials.github = {
        ...this.credentials.github,
        connected: false,
        login: null,
        method: null,
        updatedAt: null,
      };
    else if (name === 'codex')
      this.credentials.codex = { set: false, kind: null, updatedAt: null };
    else this.credentials[name] = { set: false, updatedAt: null };
    return structuredClone(this.credentials);
  }

  async githubConnectUrl(): Promise<string> {
    return `${window.location.origin}${window.location.pathname}?github=connected`;
  }

  async listTokens(): Promise<AccessToken[]> {
    await later(200);
    return structuredClone(this.tokens);
  }

  async createToken(name: string): Promise<CreatedAccessToken> {
    await later(400);
    const id = `tok_${Math.random().toString(36).slice(2, 7)}`;
    this.tokens = [
      { id, name, createdAt: iso(Date.now()), lastUsedAt: null },
      ...this.tokens,
    ];
    const token = `cat_${Array.from({ length: 40 }, () =>
      'abcdefghijkmnpqrstuvwxyz23456789'.charAt(Math.floor(Math.random() * 32)),
    ).join('')}`;
    return { id, token };
  }

  async deleteToken(id: string): Promise<void> {
    await later(300);
    this.tokens = this.tokens.filter(t => t.id !== id);
  }
}
