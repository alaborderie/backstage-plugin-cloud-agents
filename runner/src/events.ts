import { redactDeep } from './redact.ts';

export const EVENTS_VERSION = 1;

export const HARNESSES = ['claude', 'codex', 'opencode'] as const;
export type HarnessName = (typeof HARNESSES)[number];

export type ToolKind = 'shell' | 'read' | 'edit' | 'search' | 'web' | 'mcp' | 'task' | 'other';
export type RunStatus = 'succeeded' | 'failed' | 'needs_input' | 'cancelled';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
}

export interface QuestionOption {
  label: string;
  description: string | null;
}

export type EventBody =
  | {
      type: 'run.started';
      harness: HarnessName;
      model: string;
      effort: string;
      repo: string;
      base: string;
      branch: string;
      runner_version: string;
      harness_version: string | null;
    }
  | { type: 'skills.ready'; source: string; commit: string }
  | {
      type: 'workspace.ready';
      repo: string;
      branch: string;
      base: string;
      head_sha: string;
      branch_existed: boolean;
    }
  | { type: 'session.started'; session_id: string; model: string | null }
  | { type: 'assistant.message'; text: string; parent_call_id: string | null }
  | {
      type: 'tool.call';
      call_id: string;
      name: string;
      kind: ToolKind;
      input: unknown;
      parent_call_id: string | null;
    }
  | {
      type: 'tool.result';
      call_id: string;
      is_error: boolean;
      output: string;
      truncated: boolean;
      parent_call_id: string | null;
    }
  | {
      type: 'question';
      question_id: string;
      question: string;
      options: QuestionOption[];
      blocking: boolean;
      source: 'ask_user' | 'native';
    }
  | ({ type: 'usage' } & Usage)
  | {
      type: 'rate_limit';
      status: 'allowed' | 'warning' | 'limited';
      window: string | null;
      resets_at: string | null;
      utilization: number | null;
      message: string | null;
    }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; source: 'runner' | 'harness'; message: string }
  | {
      type: 'run.finished';
      status: RunStatus;
      exit_code: number;
      harness_exit_code: number | null;
      branch: string;
      head_sha: string | null;
      pushed: boolean;
      pr_url: string | null;
      open_questions: string[];
      usage: Usage;
      duration_ms: number;
      error: string | null;
    };

export type EventType = EventBody['type'];

export type RunEvent = EventBody & { v: typeof EVENTS_VERSION; seq: number; ts: string; run_id: string };

export const EXIT_CODES: Record<RunStatus, number> = {
  succeeded: 0,
  failed: 1,
  needs_input: 3,
  cancelled: 130,
};

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_tokens: 0, cost_usd: null };
}

export function addUsage(total: Usage, delta: Usage): Usage {
  return {
    input_tokens: total.input_tokens + delta.input_tokens,
    output_tokens: total.output_tokens + delta.output_tokens,
    cached_input_tokens: total.cached_input_tokens + delta.cached_input_tokens,
    reasoning_tokens: total.reasoning_tokens + delta.reasoning_tokens,
    cost_usd: total.cost_usd === null && delta.cost_usd === null ? null : (total.cost_usd ?? 0) + (delta.cost_usd ?? 0),
  };
}

export type Sink = (line: string) => void;

export class Emitter {
  private seq = 0;
  readonly emitted: RunEvent[] = [];
  private readonly runId: string;
  private readonly secrets: readonly string[];
  private readonly sink: Sink;
  private readonly now: () => Date;

  constructor(runId: string, secrets: readonly string[], sink: Sink, now: () => Date = () => new Date()) {
    this.runId = runId;
    this.secrets = secrets;
    this.sink = sink;
    this.now = now;
  }

  emit(body: EventBody): RunEvent {
    const event = redactDeep(
      { v: EVENTS_VERSION, seq: this.seq++, ts: this.now().toISOString(), run_id: this.runId, ...body },
      this.secrets,
    ) as RunEvent;
    this.emitted.push(event);
    this.sink(JSON.stringify(event));
    return event;
  }
}
