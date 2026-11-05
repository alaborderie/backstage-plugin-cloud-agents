import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseEnv, runProc } from '../src/proc.ts';

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

test('harness processes keep the build tool locations but no credentials', () => {
  const env = baseEnv({
    PATH: '/usr/local/cargo/bin:/usr/bin',
    RUSTUP_HOME: '/usr/local/rustup',
    CARGO_HOME: '/usr/local/cargo',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    NODE_PATH: '/usr/local/lib/node_modules',
    PIP_BREAK_SYSTEM_PACKAGES: '1',
    GH_TOKEN: 'secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
  });
  assert.deepEqual(env, {
    PATH: '/usr/local/cargo/bin:/usr/bin',
    RUSTUP_HOME: '/usr/local/rustup',
    CARGO_HOME: '/usr/local/cargo',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    NODE_PATH: '/usr/local/lib/node_modules',
    PIP_BREAK_SYSTEM_PACKAGES: '1',
  });
});
