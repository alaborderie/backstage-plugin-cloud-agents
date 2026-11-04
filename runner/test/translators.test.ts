import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Emitter, HARNESSES } from '../src/events.ts';
import type { RunEvent } from '../src/events.ts';
import { harnesses } from '../src/harnesses/index.ts';
import { makeValidator } from '../scripts/validate-events.ts';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const validate = makeValidator();

function translateFixture(harness: (typeof HARNESSES)[number], file: string): RunEvent[] {
  const translator = harnesses[harness].createTranslator();
  const emitter = new Emitter('fixture', [], () => undefined, () => new Date(0));
  for (const line of readFileSync(join(fixtures, harness, file), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    for (const body of translator.translate(JSON.parse(line))) emitter.emit(body);
  }
  return emitter.emitted;
}

for (const harness of HARNESSES) {
  describe(`${harness} translator`, () => {
    const files = readdirSync(join(fixtures, harness)).filter((f) => f.endsWith('.jsonl'));
    test('has recorded fixtures', () => {
      assert.ok(files.length > 0);
    });
    for (const file of files) {
      test(`${file}: every event matches the v1 schema`, () => {
        const events = translateFixture(harness, file);
        assert.ok(events.length > 0);
        for (const event of events) assert.deepEqual(validate(event), [], JSON.stringify(event).slice(0, 300));
      });
      test(`${file}: starts a session, pairs each tool call with its result, reports usage`, () => {
        const events = translateFixture(harness, file);
        assert.equal(events.filter((e) => e.type === 'session.started').length, 1);
        const calls = events.flatMap((e) => (e.type === 'tool.call' ? [e.call_id] : []));
        const results = events.flatMap((e) => (e.type === 'tool.result' ? [e.call_id] : []));
        assert.ok(calls.length > 0, 'fixture exercises at least one tool');
        assert.deepEqual([...results].sort(), [...calls].sort());
        assert.ok(events.some((e) => e.type === 'usage'));
        assert.ok(events.some((e) => e.type === 'assistant.message'));
      });
    }
  });
}

test('a shell command keeps its kind and output across harnesses', () => {
  for (const harness of HARNESSES) {
    for (const file of readdirSync(join(fixtures, harness)).filter((f) => f.endsWith('.jsonl'))) {
      const events = translateFixture(harness, file);
      const shell = events.find((e) => e.type === 'tool.call' && e.kind === 'shell');
      if (shell?.type !== 'tool.call') continue;
      const result = events.find((e) => e.type === 'tool.result' && e.call_id === shell.call_id);
      assert.ok(result?.type === 'tool.result' && result.output.length > 0, `${harness}/${file}`);
    }
  }
});

test('questions from the ask_user tool or a native question tool become question events, not tool calls', () => {
  const questions = HARNESSES.flatMap((harness) =>
    readdirSync(join(fixtures, harness))
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((file) => translateFixture(harness, file).map((e) => ({ harness, e }))),
  ).filter(({ e }) => e.type === 'question');
  assert.ok(questions.length > 0, 'at least one fixture asks a question');
  for (const { harness, e } of questions) {
    assert.ok(e.type === 'question' && e.question.length > 0, harness);
  }
});
