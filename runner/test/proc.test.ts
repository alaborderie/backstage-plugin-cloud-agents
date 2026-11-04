import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProc } from '../src/proc.ts';

test('cancelling a run also stops the commands the harness started', async () => {
  const abort = new AbortController();
  const started = Date.now();
  const result = runProc('sh', ['-c', 'sleep 300 & sleep 300'], { env: { PATH: process.env.PATH ?? '' }, signal: abort.signal });
  setTimeout(() => {
    abort.abort();
  }, 300);
  const timeout = new Promise<'hung'>((resolve) => {
    setTimeout(() => {
      resolve('hung');
    }, 15_000).unref();
  });
  assert.notEqual(await Promise.race([result, timeout]), 'hung');
  assert.ok(Date.now() - started < 15_000);
});
