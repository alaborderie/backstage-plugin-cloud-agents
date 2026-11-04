import type {
  AgentEventEnvelope,
  PluginEvent,
  RunnerEvent,
  RunReason,
} from '@alaborderie/plugin-cloud-agents-common';

type AnyEvent = RunnerEvent | PluginEvent;
type EventType = AnyEvent['type'];
export type Ev<T extends EventType> = Extract<AnyEvent, { type: T }>;

/** A tool call and, once it arrived, its result, paired by `call_id`. */
export interface ToolCall {
  key: string;
  seq: number;
  call: Ev<'tool.call'>;
  result?: Ev<'tool.result'>;
}

interface Base {
  key: string;
  /** The seq of the event that created the item. */
  seq: number;
}

export interface SetupItem extends Base {
  kind: 'setup';
  runId: string;
  ts: string;
  started?: Ev<'run.started'>;
  skills?: Ev<'skills.ready'>;
  workspace?: Ev<'workspace.ready'>;
  session?: Ev<'session.started'>;
}

export interface QuestionItem extends Base {
  kind: 'question';
  runId: string;
  event: Ev<'question'>;
  /** A later run started with the answers. */
  answered: boolean;
}

/** One row of the timeline. Several events can make one item. */
export type Item =
  | (Base & {
      kind: 'run';
      runId: string;
      ordinal: number;
      reason: RunReason;
      ts: string;
    })
  | SetupItem
  | (Base & { kind: 'message'; event: Ev<'assistant.message'> })
  | (Base & { kind: 'you'; event: Ev<'agent.message'> })
  | (Base & { kind: 'tool'; tool: ToolCall })
  | (Base & { kind: 'explored'; tools: ToolCall[] })
  | QuestionItem
  | (Base & { kind: 'rate_limit'; event: Ev<'rate_limit'> })
  | (Base & { kind: 'log'; event: Ev<'log'> })
  | (Base & { kind: 'finished'; runId: string; event: Ev<'run.finished'> })
  | (Base & { kind: 'agent_error'; event: Ev<'agent.status'> })
  | (Base & { kind: 'unknown'; event: { type: string } });

export interface Usage {
  input: number;
  cached: number;
  output: number;
  /** Null until a harness reports a cost; Codex never does. */
  costUsd: number | null;
}

export interface Timeline {
  items: Item[];
  usage: Usage;
  rateLimit: Ev<'rate_limit'> | undefined;
  runStarted: Ev<'run.started'> | undefined;
  headSha: string | undefined;
}

const EXPLORE_KINDS = new Set(['read', 'search']);

class Builder implements Timeline {
  items: Item[] = [];
  usage: Usage = { input: 0, cached: 0, output: 0, costUsd: null };
  rateLimit: Ev<'rate_limit'> | undefined;
  runStarted: Ev<'run.started'> | undefined;
  headSha: string | undefined;
  runs = 0;
  lastRunId: string | undefined;
  private explore: ToolCall[] = [];
  private readonly tools = new Map<string, ToolCall>();
  private readonly setups = new Map<string, SetupItem>();
  private readonly questions = new Map<string, QuestionItem[]>();

  push(item: Item): void {
    this.flush();
    this.items.push(item);
  }

  /** Consecutive reads and searches fold into one "Explored" row. */
  flush(): void {
    const [first, ...rest] = this.explore;
    if (first && !rest.length) {
      this.items.push({
        kind: 'tool',
        key: first.key,
        seq: first.seq,
        tool: first,
      });
    } else if (first) {
      this.items.push({
        kind: 'explored',
        key: `explored:${first.key}`,
        seq: first.seq,
        tools: this.explore,
      });
    }
    this.explore = [];
  }

  setup(env: AgentEventEnvelope, ts: string): SetupItem {
    let item = this.setups.get(env.runId);
    if (!item) {
      item = {
        kind: 'setup',
        key: `setup:${env.runId}`,
        seq: env.seq,
        runId: env.runId,
        ts,
      };
      this.setups.set(env.runId, item);
      this.push(item);
    }
    return item;
  }

  tool(env: AgentEventEnvelope, call: Ev<'tool.call'>): void {
    const tool: ToolCall = {
      key: `tool:${env.runId}:${call.call_id}`,
      seq: env.seq,
      call,
    };
    this.tools.set(`${env.runId}:${call.call_id}`, tool);
    if (EXPLORE_KINDS.has(call.kind)) this.explore.push(tool);
    else this.push({ kind: 'tool', key: tool.key, seq: env.seq, tool });
  }

  result(env: AgentEventEnvelope, result: Ev<'tool.result'>): void {
    const tool = this.tools.get(`${env.runId}:${result.call_id}`);
    if (tool) tool.result = result;
    else
      this.push({
        kind: 'unknown',
        key: `ev:${env.seq}`,
        seq: env.seq,
        event: result,
      });
  }

  question(env: AgentEventEnvelope, event: Ev<'question'>): void {
    const item: QuestionItem = {
      kind: 'question',
      key: `ev:${env.seq}`,
      seq: env.seq,
      runId: env.runId,
      event,
      answered: false,
    };
    this.questions.set(env.runId, [
      ...(this.questions.get(env.runId) ?? []),
      item,
    ]);
    this.push(item);
  }

  runStartedBy(env: AgentEventEnvelope, event: Ev<'agent.run_started'>): void {
    if (event.reason === 'reply' && this.lastRunId) {
      for (const q of this.questions.get(this.lastRunId) ?? [])
        q.answered = true;
    }
    this.lastRunId = event.runId;
    this.push({
      kind: 'run',
      key: `run:${event.runId}`,
      seq: env.seq,
      runId: event.runId,
      ordinal: ++this.runs,
      reason: event.reason,
      ts: event.ts,
    });
  }
}

type Fold = {
  [T in EventType]: (b: Builder, event: Ev<T>, env: AgentEventEnvelope) => void;
};

/**
 * How each event type of runner/EVENTS.md and of the plugin's `agent.*`
 * namespace lands in the timeline.
 */
const FOLD: Fold = {
  'agent.run_started': (b, e, env) => b.runStartedBy(env, e),
  'agent.message': (b, e, env) =>
    b.push({ kind: 'you', key: `ev:${env.seq}`, seq: env.seq, event: e }),
  'agent.status': (b, e, env) => {
    if (e.error) {
      b.push({
        kind: 'agent_error',
        key: `ev:${env.seq}`,
        seq: env.seq,
        event: e,
      });
    }
  },
  'run.started': (b, e, env) => {
    b.setup(env, e.ts).started = e;
    b.runStarted = e;
  },
  'skills.ready': (b, e, env) => {
    b.setup(env, e.ts).skills = e;
  },
  'workspace.ready': (b, e, env) => {
    b.setup(env, e.ts).workspace = e;
    b.headSha = e.head_sha;
  },
  'session.started': (b, e, env) => {
    b.setup(env, e.ts).session = e;
  },
  'assistant.message': (b, e, env) =>
    b.push({ kind: 'message', key: `ev:${env.seq}`, seq: env.seq, event: e }),
  'tool.call': (b, e, env) => b.tool(env, e),
  'tool.result': (b, e, env) => b.result(env, e),
  question: (b, e, env) => b.question(env, e),
  usage: (b, e) => {
    b.usage = {
      input: b.usage.input + e.input_tokens,
      cached: b.usage.cached + e.cached_input_tokens,
      output: b.usage.output + e.output_tokens,
      costUsd:
        e.cost_usd === null
          ? b.usage.costUsd
          : (b.usage.costUsd ?? 0) + e.cost_usd,
    };
  },
  rate_limit: (b, e, env) => {
    b.rateLimit = e;
    if (e.status !== 'allowed') {
      b.push({
        kind: 'rate_limit',
        key: `ev:${env.seq}`,
        seq: env.seq,
        event: e,
      });
    }
  },
  log: (b, e, env) =>
    b.push({ kind: 'log', key: `ev:${env.seq}`, seq: env.seq, event: e }),
  'run.finished': (b, e, env) => {
    if (e.head_sha) b.headSha = e.head_sha;
    b.push({
      kind: 'finished',
      key: `ev:${env.seq}`,
      seq: env.seq,
      runId: env.runId,
      event: e,
    });
  },
};

/** Folds an agent's envelopes, in seq order, into timeline rows and totals. */
export function buildTimeline(
  envelopes: readonly AgentEventEnvelope[],
): Timeline {
  const b = new Builder();
  for (const env of envelopes) {
    const fold = (FOLD as Record<string, Fold[EventType] | undefined>)[
      env.event.type
    ] as
      | ((b: Builder, e: AnyEvent, env: AgentEventEnvelope) => void)
      | undefined;
    if (fold) fold(b, env.event, env);
    else
      b.push({
        kind: 'unknown',
        key: `ev:${env.seq}`,
        seq: env.seq,
        event: env.event,
      });
  }
  b.flush();
  return b;
}

/** The option descriptions of a question, from its `question` event. */
export function questionEvents(
  envelopes: readonly AgentEventEnvelope[],
): Map<string, Ev<'question'>> {
  const byKey = new Map<string, Ev<'question'>>();
  for (const env of envelopes) {
    if (env.event.type === 'question') {
      byKey.set(`${env.runId}:${env.event.question_id}`, env.event);
    }
  }
  return byKey;
}
