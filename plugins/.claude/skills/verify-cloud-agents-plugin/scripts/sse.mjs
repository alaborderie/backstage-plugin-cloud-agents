#!/usr/bin/env node
// Usage: sse.mjs summary <file.sse>          prints seqs, event types, and whether the stream ended on a terminal agent.status
//        sse.mjs compare <full.sse> <part.sse> <after>   checks that part is exactly the messages of full after seq <after>
//        sse.mjs join <out.sse> <a.sse> <b.sse>          checks that a then b form one gapless stream and writes it
import { readFileSync, writeFileSync } from 'node:fs';

function parse(file) {
  return readFileSync(file, 'utf8')
    .split('\n\n')
    .map(block => block.split('\n').filter(l => l && !l.startsWith(':')))
    .filter(lines => lines.length)
    .map(lines => {
      const f = Object.fromEntries(
        lines.map(l => [
          l.slice(0, l.indexOf(':')),
          l.slice(l.indexOf(':') + 2),
        ]),
      );
      return {
        id: Number(f.id),
        event: f.event,
        data: f.data,
        parsed: JSON.parse(f.data),
      };
    });
}

function check(ok, message) {
  if (!ok) {
    console.error(`FAIL ${message}`);
    process.exit(1);
  }
  console.error(`ok ${message}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'summary') {
  const m = parse(args[0]);
  const last = m[m.length - 1]?.parsed.event;
  const runner = m.filter(x => !x.parsed.event.type.startsWith('agent.'));
  const byRun = new Map();
  for (const x of runner)
    byRun.set(x.parsed.runId, [
      ...(byRun.get(x.parsed.runId) ?? []),
      x.parsed.event.seq,
    ]);
  const summary = {
    messages: m.length,
    firstSeq: m[0]?.id,
    lastSeq: m[m.length - 1]?.id,
    gapless: m.every((x, i) => x.id === i + 1),
    runnerEvents: runner.length,
    runnerSeqsContiguous: [...byRun.values()].every(seqs =>
      seqs.every((s, i) => s === i),
    ),
    types: [...new Set(m.map(x => x.parsed.event.type))],
    last,
    prUrl:
      runner.find(x => x.parsed.event.type === 'run.finished')?.parsed.event
        .pr_url ?? null,
  };
  console.log(JSON.stringify(summary, null, 2));
  check(
    summary.gapless && summary.runnerSeqsContiguous,
    'agent seqs run 1..n and each run has runner seqs 0..k once each',
  );
} else if (cmd === 'compare') {
  const full = parse(args[0]);
  const part = parse(args[1]);
  const after = Number(args[2]);
  const expected = full.filter(x => x.id > after);
  check(
    part.length === expected.length,
    `replay after ${after} has ${part.length} messages, the first stream has ${expected.length} after it`,
  );
  check(
    part.every(
      (x, i) =>
        x.id === expected[i].id &&
        x.event === expected[i].event &&
        x.data === expected[i].data,
    ),
    'replayed messages are byte for byte the first stream',
  );
} else if (cmd === 'join') {
  const [out, a, b] = args;
  const all = [...parse(a), ...parse(b)];
  check(
    all.every((x, i) => x.id === i + 1),
    `reconnected stream is gapless from 1 to ${all.length}`,
  );
  writeFileSync(
    out,
    all
      .map(x => `id: ${x.id}\nevent: ${x.event}\ndata: ${x.data}\n\n`)
      .join(''),
  );
} else {
  console.error('usage: sse.mjs summary|compare|join ...');
  process.exit(2);
}
