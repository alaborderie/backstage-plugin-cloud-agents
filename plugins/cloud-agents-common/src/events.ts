/** The harnesses the runner image can drive. */
export type Harness = 'claude' | 'codex' | 'opencode';

export const HARNESSES: readonly Harness[] = ['claude', 'codex', 'opencode'];

/** The runner's `tool.call.kind`. */
export type ToolKind =
  | 'shell'
  | 'read'
  | 'edit'
  | 'search'
  | 'web'
  | 'mcp'
  | 'task'
  | 'other';

interface RunnerEventBase {
  v: 1;
  seq: number;
  ts: string;
  run_id: string;
}

export interface UsageFields {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
}

/** The runner's `run.finished.status`. */
export type RunnerFinishStatus =
  | 'succeeded'
  | 'failed'
  | 'needs_input'
  | 'cancelled';

/**
 * One line of the runner's JSONL stream, version 1, as `runner/EVENTS.md`
 * defines it. The plugin stores and streams these unchanged.
 */
export type RunnerEvent = RunnerEventBase &
  (
    | {
        type: 'run.started';
        harness: Harness;
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
    | {
        type: 'assistant.message';
        text: string;
        parent_call_id: string | null;
      }
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
        options: Array<{ label: string; description: string | null }>;
        blocking: boolean;
        source: 'ask_user' | 'native';
      }
    | ({ type: 'usage' } & UsageFields)
    | {
        type: 'rate_limit';
        status: 'allowed' | 'warning' | 'limited';
        window: string | null;
        resets_at: string | null;
        utilization: number | null;
        message: string | null;
      }
    | {
        type: 'log';
        level: 'info' | 'warn' | 'error';
        source: 'runner' | 'harness';
        message: string;
      }
    | {
        type: 'run.finished';
        status: RunnerFinishStatus;
        exit_code: 0 | 1 | 3 | 130;
        harness_exit_code: number | null;
        branch: string;
        head_sha: string | null;
        pushed: boolean;
        pr_url: string | null;
        open_questions: string[];
        usage: UsageFields;
        duration_ms: number;
        error: string | null;
      }
  );

export type RunnerEventType = RunnerEvent['type'];

const SUMMARY_KEYS = [
  'command',
  'cmd',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'query',
  'url',
  'description',
];

/**
 * One line that says what a `tool.call` does, from the first familiar key of
 * its `input`: the command, the file, the pattern, or the URL.
 */
export function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of SUMMARY_KEYS) {
      const value = record[key];
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.join(' ');
    }
  }
  return typeof input === 'string' ? input : JSON.stringify(input) ?? '';
}
