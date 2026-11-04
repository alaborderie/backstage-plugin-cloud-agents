import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HARNESSES } from '../src/events.ts';
import type { RunEvent } from '../src/events.ts';
import { validateStream } from '../scripts/validate-events.ts';

for (const harness of HARNESSES) {
  test(`the recorded ${harness} sandbox run is a valid v1 stream that ends in a pushed branch with a pull request`, () => {
    const text = readFileSync(new URL(`./streams/${harness}.jsonl`, import.meta.url), 'utf8');
    assert.deepEqual(validateStream(text), []);
    const events = text.trim().split('\n').map((l) => JSON.parse(l) as RunEvent);
    const started = events[0];
    const finished = events.at(-1);
    assert.ok(started?.type === 'run.started' && started.harness === harness);
    assert.ok(finished?.type === 'run.finished');
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.pushed, true);
    assert.match(finished.pr_url ?? '', /^https:\/\/github\.com\/alaborderie\/cloud-agent-runner-sandbox\/pull\/\d+$/);
    assert.ok(events.some((e) => e.type === 'question' && e.source === 'ask_user'), 'the agent asked through ask_user');
  });
}

for (const [file, status, exitCode] of [
  ['opencode-needs-input', 'needs_input', 3],
  ['opencode-cancelled', 'cancelled', 130],
] as const) {
  test(`the recorded ${file} run is a valid v1 stream that ends as ${status}`, () => {
    const text = readFileSync(new URL(`./streams/${file}.jsonl`, import.meta.url), 'utf8');
    assert.deepEqual(validateStream(text), []);
    const finished = JSON.parse(text.trim().split('\n').at(-1) ?? '{}') as RunEvent;
    assert.ok(finished.type === 'run.finished');
    assert.equal(finished.status, status);
    assert.equal(finished.exit_code, exitCode);
    if (status === 'needs_input') assert.ok(finished.open_questions.length > 0);
  });
}
