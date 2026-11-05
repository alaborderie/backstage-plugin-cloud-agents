import { envelope, iso, NOW } from '../../__testUtils__/fixtures';
import { buildTimeline, type Item } from './timeline';

const usage = (
  input: number,
  cached: number,
  output: number,
  cost: number | null,
) =>
  ({
    type: 'usage',
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_tokens: 0,
    cost_usd: cost,
  } as const);

const call = (
  call_id: string,
  kind: 'read' | 'search' | 'shell',
  input: unknown,
) =>
  ({
    type: 'tool.call',
    call_id,
    name: kind,
    kind,
    input,
    parent_call_id: null,
  } as const);

const result = (call_id: string, output: string) =>
  ({
    type: 'tool.result',
    call_id,
    is_error: false,
    output,
    truncated: false,
    parent_call_id: null,
  } as const);

const rateLimit = (status: 'allowed' | 'limited') =>
  ({
    type: 'rate_limit',
    status,
    window: '5h',
    resets_at: null,
    utilization: 0.4,
    message: null,
  } as const);

const setup = (seq: number, runId: string) => [
  envelope(seq, runId, {
    type: 'run.started',
    harness: 'opencode',
    model: 'opencode-go/deepseek-v4.1-flash',
    effort: 'high',
    repo: 'acme/acme-api',
    base: 'main',
    branch: 'cloud-agent/1',
    runner_version: '1.0.0',
    harness_version: null,
  }),
  envelope(seq + 1, runId, {
    type: 'skills.ready',
    source: 'acme/skills',
    commit: 'abcdef1234',
  }),
  envelope(seq + 2, runId, {
    type: 'workspace.ready',
    repo: 'acme/acme-api',
    branch: 'cloud-agent/1',
    base: 'main',
    head_sha: '1234567890abcdef',
    branch_existed: false,
  }),
  envelope(seq + 3, runId, {
    type: 'session.started',
    session_id: 's-1',
    model: null,
  }),
];

const runStarted = (
  seq: number,
  runId: string,
  reason: 'initial' | 'message',
) =>
  envelope(seq, runId, {
    type: 'agent.run_started',
    runId,
    reason,
    ts: iso(NOW),
  });

const events = [
  runStarted(1, 'run-1', 'initial'),
  ...setup(2, 'run-1'),
  envelope(6, 'run-1', {
    type: 'assistant.message',
    text: 'Looking around.',
    parent_call_id: null,
  }),
  envelope(7, 'run-1', call('c1', 'read', { file_path: 'src/app.ts' })),
  envelope(8, 'run-1', call('c2', 'search', { pattern: 'healthz' })),
  envelope(9, 'run-1', result('c1', 'export const app')),
  envelope(10, 'run-1', result('c2', 'no matches')),
  envelope(11, 'run-1', call('c3', 'shell', { command: 'yarn test' })),
  envelope(12, 'run-1', result('c3', 'ok')),
  envelope(13, 'run-1', usage(1000, 200, 50, 0.01)),
  envelope(14, 'run-1', rateLimit('allowed')),
  envelope(15, 'run-1', usage(3000, 300, 70, 0.02)),
  envelope(16, 'run-1', { type: 'something.new' } as never),
  envelope(17, 'run-1', rateLimit('limited')),
  envelope(18, 'run-1', call('c4', 'read', { file_path: 'README.md' })),
  envelope(19, 'run-1', {
    type: 'agent.message',
    text: 'Also add a test',
    ts: iso(NOW),
  }),
  runStarted(20, 'run-2', 'message'),
  ...setup(21, 'run-2'),
];

describe('buildTimeline', () => {
  const timeline = buildTimeline(events);
  const kinds = timeline.items.map(item => item.kind);
  const find = <K extends Item['kind']>(kind: K) =>
    timeline.items.filter(
      (i): i is Extract<Item, { kind: K }> => i.kind === kind,
    );

  it('lays out one row per step, in stream order', () => {
    expect(kinds).toEqual([
      'run',
      'setup',
      'message',
      'explored',
      'tool',
      'unknown',
      'rate_limit',
      'tool',
      'you',
      'run',
      'setup',
    ]);
  });

  it('collapses the four setup events into one item per run', () => {
    const setups = find('setup');
    expect(setups.map(s => s.runId)).toEqual(['run-1', 'run-2']);
    for (const item of setups) {
      expect(item.started?.runner_version).toBe('1.0.0');
      expect(item.skills?.source).toBe('acme/skills');
      expect(item.workspace?.head_sha).toBe('1234567890abcdef');
      expect(item.session?.session_id).toBe('s-1');
    }
  });

  it('pairs tool results with their calls by call_id', () => {
    const [shell, lone] = find('tool');
    expect(shell!.tool.call.call_id).toBe('c3');
    expect(shell!.tool.result?.output).toBe('ok');
    expect(lone!.tool.call.call_id).toBe('c4');
    expect(lone!.tool.result).toBeUndefined();
  });

  it('folds consecutive reads and searches into one explored item', () => {
    const [explored] = find('explored');
    expect(
      explored!.tools.map(t => [t.call.call_id, t.result?.output]),
    ).toEqual([
      ['c1', 'export const app'],
      ['c2', 'no matches'],
    ]);
  });

  it('sums usage deltas', () => {
    expect(timeline.usage).toEqual({
      input: 4000,
      cached: 500,
      output: 120,
      costUsd: expect.closeTo(0.03),
    });
  });

  it('hides allowed rate limits but keeps the latest for the meter', () => {
    expect(find('rate_limit').map(i => i.event.status)).toEqual(['limited']);
    expect(timeline.rateLimit?.status).toBe('limited');
  });

  it('keeps unknown event types', () => {
    expect(find('unknown').map(i => i.event.type)).toEqual(['something.new']);
  });

  it('marks the follow-up run with its reason and ordinal', () => {
    expect(find('run').map(r => [r.ordinal, r.reason])).toEqual([
      [1, 'initial'],
      [2, 'message'],
    ]);
  });
});
