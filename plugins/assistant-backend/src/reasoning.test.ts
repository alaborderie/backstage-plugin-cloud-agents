import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askClaudeCode } from './reasoning';

const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));

function fakeClaude(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return path;
}

const ask = (claudePath: string, timeoutMs = 10_000) =>
  askClaudeCode(
    { model: 'claude-opus-5-5', claudePath, timeoutMs },
    'sk-ant-oat01-token',
    'Why?',
    new AbortController().signal,
  );

describe('askClaudeCode', () => {
  it('reports a rejected token as an invalid Claude Code credential', async () => {
    const claude = fakeClaude(
      'rejected',
      `process.stdout.write(JSON.stringify({ is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }));
process.exit(1);`,
    );
    expect(await ask(claude)).toMatchObject({
      error: 'invalid_claude_credential',
      message: expect.stringContaining('claude setup-token'),
    });
  });

  it('reports a missing CLI', async () => {
    expect(await ask(join(dir, 'not-installed'))).toMatchObject({
      error: 'claude_code_missing',
      message: expect.stringContaining('ENOENT'),
    });
  });

  it('kills Claude Code and reports a timeout', async () => {
    const claude = fakeClaude('slow', 'setTimeout(() => {}, 60_000);');
    const started = Date.now();
    expect(await ask(claude, 300)).toMatchObject({
      error: 'claude_code_timeout',
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports a crash with its stderr', async () => {
    const claude = fakeClaude(
      'crash',
      `process.stderr.write('segfault-ish'); process.exit(2);`,
    );
    expect(await ask(claude)).toEqual({
      error: 'claude_code_failed',
      message: 'Claude Code exited with 2: segfault-ish',
    });
  });

  it('stops Claude Code when the chat turn is aborted', async () => {
    const claude = fakeClaude('hang', 'setTimeout(() => {}, 60_000);');
    const controller = new AbortController();
    const pending = askClaudeCode(
      { model: 'claude-opus-5-5', claudePath: claude, timeoutMs: 60_000 },
      'sk-ant-oat01-token',
      'Why?',
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error('Stopped')), 100);
    await expect(pending).rejects.toThrow('Stopped');
  });
});
