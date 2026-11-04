import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openAskChannel, sendQuestion } from '../src/ask-channel.ts';
import { handle } from '../src/ask-mcp.ts';
import { Emitter } from '../src/events.ts';
import { harnesses } from '../src/harnesses/index.ts';
import { ASK_TOOL } from '../src/harnesses/types.ts';
import { collectSecrets } from '../src/redact.ts';
import { makeValidator } from '../scripts/validate-events.ts';

const validate = makeValidator();

test('credentials from env and a codex auth.json never reach the event stream', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-agent-test-'));
  const auth = join(dir, 'auth.json');
  writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'eyJaccess.token.value', refresh_token: 'rt_refresh_value_123' } }));
  const secrets = collectSecrets({ GH_TOKEN: 'ghp_exampletoken123', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-example', CODEX_AUTH_JSON: auth, HOME: '/home/agent' });
  const lines: string[] = [];
  const emitter = new Emitter('run-1', secrets, (l) => lines.push(l));
  emitter.emit({
    type: 'tool.result',
    call_id: 'c1',
    is_error: false,
    output: 'GH_TOKEN=ghp_exampletoken123 claude=sk-ant-oat01-example refresh=rt_refresh_value_123',
    truncated: false,
    parent_call_id: null,
  });
  emitter.emit({ type: 'tool.call', call_id: 'c2', name: 'Bash', kind: 'shell', input: { command: 'echo eyJaccess.token.value' }, parent_call_id: null });
  const out = lines.join('\n');
  for (const secret of ['ghp_exampletoken123', 'sk-ant-oat01-example', 'rt_refresh_value_123', 'eyJaccess.token.value']) {
    assert.ok(!out.includes(secret), secret);
  }
  assert.ok(!secrets.includes('/home/agent'), 'only credential variables are secrets');
  assert.ok(!secrets.includes('chatgpt'), 'short auth.json values are not treated as secrets');
  for (const event of emitter.emitted) assert.deepEqual(validate(event), []);
});

test('each harness refuses to start without its own credential and never receives another harness credential', () => {
  const home = mkdtempSync(join(tmpdir(), 'cloud-agent-home-'));
  const spec = { model: 'm', effort: 'high', prompt: 'p', workdir: home, home, askSocket: join(home, 'ask.sock') };
  const all = { CLAUDE_CODE_OAUTH_TOKEN: 'claude-token-value', OPENAI_API_KEY: 'openai-key-value', OPENCODE_API_KEY: 'opencode-key-value' };
  assert.throws(() => harnesses.claude.prepare(spec, {}), /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.throws(() => harnesses.codex.prepare(spec, {}), /CODEX_API_KEY/);
  assert.throws(() => harnesses.opencode.prepare(spec, {}), /OPENCODE_API_KEY/);
  assert.deepEqual(Object.values(harnesses.claude.prepare(spec, all)), ['claude-token-value']);
  assert.ok(!Object.values(harnesses.codex.prepare(spec, all)).includes('claude-token-value'));
  assert.ok(!Object.values(harnesses.opencode.prepare(spec, all)).includes('claude-token-value'));
});

test('an ask_user call reaches the runner through its socket and the agent is told no one will answer', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'cloud-agent-ask-')), 'ask.sock');
  const received: unknown[] = [];
  const channel = await openAskChannel(socket, (input) => {
    received.push(input);
    return { answer: null };
  });
  const ask = (input: unknown) => sendQuestion(socket, input);
  try {
    const init = await handle('initialize', { protocolVersion: '2025-06-18' }, ask);
    assert.ok(init && 'result' in init);
    const list = await handle('tools/list', {}, ask);
    assert.ok(list && 'result' in list);
    assert.match(JSON.stringify(list.result), new RegExp(`"name":"${ASK_TOOL}"`));
    const call = await handle('tools/call', { name: ASK_TOOL, arguments: { question: 'Red or blue?', blocking: false } }, ask);
    assert.ok(call && 'result' in call);
    assert.match(JSON.stringify(call.result), /No one can answer during this run/);
    assert.deepEqual(received, [{ question: 'Red or blue?', blocking: false }]);
    assert.equal(await handle('notifications/initialized', {}, ask), null);
    const unknown = await handle('resources/list', {}, ask);
    assert.ok(unknown && 'error' in unknown);
  } finally {
    await channel.close();
  }
});

test('ask_user still answers when no runner is listening', async () => {
  const call = await handle('tools/call', { name: ASK_TOOL, arguments: { question: 'Red or blue?' } }, () => sendQuestion('/nonexistent/ask.sock', {}));
  assert.ok(call && 'result' in call);
  assert.match(JSON.stringify(call.result), /did not acknowledge/);
});
