import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { callTool, openToolChannel } from '../src/ask-channel.ts';
import { handle } from '../src/ask-mcp.ts';
import type { Call } from '../src/ask-mcp.ts';
import { Emitter } from '../src/events.ts';
import { harnesses } from '../src/harnesses/index.ts';
import { ASK_TOOL, NO_REPLY, askCommand } from '../src/harnesses/types.ts';
import { callHubTool, hubContext, isHubTool } from '../src/hub-tools.ts';
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
  const fetchedMidRun = 'ghu_RefreshedAfterTheRunStarted0123456789';
  emitter.emit({ type: 'log', level: 'info', source: 'harness', message: `token ${fetchedMidRun}` });
  assert.match(lines.at(-1) ?? '', /"message":"token \[REDACTED\]"/, 'a GitHub token in no variable is redacted by its format');
  assert.ok(!secrets.includes('chatgpt'), 'short auth.json values are not treated as secrets');
  for (const event of emitter.emitted) assert.deepEqual(validate(event), []);
});

test('each harness refuses to start without its own credential and never receives another harness credential', () => {
  const home = mkdtempSync(join(tmpdir(), 'cloud-agent-home-'));
  const spec = { model: 'm', effort: 'high', prompt: 'p', workdir: home, home, askSocket: join(home, 'ask.sock'), hub: false };
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
  const channel = await openToolChannel(socket, ({ input }) => {
    received.push(input);
    return Promise.resolve({ text: NO_REPLY, isError: false });
  });
  const call: Call = (toolCall, timeoutMs) => callTool(socket, toolCall, timeoutMs);
  try {
    const init = await handle('initialize', { protocolVersion: '2025-06-18' }, call);
    assert.ok(init && 'result' in init);
    const list = await handle('tools/list', {}, call);
    assert.ok(list && 'result' in list);
    assert.deepEqual(rec(list.result).tools.map((t: { name: string }) => t.name), [ASK_TOOL]);
    const result = await handle('tools/call', { name: ASK_TOOL, arguments: { question: 'Red or blue?', blocking: false } }, call);
    assert.ok(result && 'result' in result);
    assert.match(JSON.stringify(result.result), /No one can answer during this run/);
    assert.deepEqual(received, [{ question: 'Red or blue?', blocking: false }]);
    const hubTool = await handle('tools/call', { name: 'list_children', arguments: {} }, call);
    assert.ok(hubTool && 'error' in hubTool, 'a task run has no hub tools');
    assert.equal(await handle('notifications/initialized', {}, call), null);
    const unknown = await handle('resources/list', {}, call);
    assert.ok(unknown && 'error' in unknown);
  } finally {
    await channel.close();
  }
});

function rec(value: unknown): { tools: { name: string }[] } & Record<string, unknown> {
  return value as { tools: { name: string }[] } & Record<string, unknown>;
}

test('a hub run offers the hub tools and calls the plugin actions with its run token', async () => {
  const requests: { method: string; url: string; auth: string; body: unknown }[] = [];
  const answers: Record<string, [number, unknown]> = {
    'POST /api/cloud-agents/.backstage/actions/v1/actions/cloud-agents:create-agent/invoke': [200, { output: { agent: { id: 'ag_child', parentId: 'ag_hub' } } }],
    'POST /api/cloud-agents/.backstage/actions/v1/actions/cloud-agents:list-agents/invoke': [200, { output: { agents: [{ id: 'ag_child' }] } }],
    'POST /api/cloud-agents/.backstage/actions/v1/actions/cloud-agents:get-agent/invoke': [403, { error: { name: 'NotAllowedError', message: 'not_your_child' } }],
    'POST /api/cloud-agents/.backstage/actions/v1/actions/cloud-agents:send-agent-message/invoke': [409, { error: { name: 'ConflictError', message: 'Agent ag_child has an active run' } }],
    'POST /api/cloud-agents/.backstage/actions/v1/actions/cloud-agents:reply-to-agent/invoke': [422, { error: { name: 'MissingCredentialError', message: 'missing opencode credential' } }],
    'POST /api/cloud-agents/.backstage/actions/v1/actions/cloud-agents:stop-agent/invoke': [404, { error: { name: 'NotFoundError', message: 'No agent ag_gone' } }],
    'PUT /api/cloud-agents/runner/hub/state': [200, {}],
    'GET /api/cloud-agents/runner/hub/state': [200, { state: { plan: ['a'] } }],
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? '', body: raw ? JSON.parse(raw) : null });
      const [status, body] = answers[`${req.method ?? ''} ${req.url ?? ''}`] ?? [500, {}];
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    CLOUD_AGENT_KIND: 'hub',
    CLOUD_AGENT_API_URL: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/cloud-agents`,
    CLOUD_AGENT_RUN_TOKEN: 'cahub.run.1.sig',
  };
  assert.equal(hubContext({ ...env, CLOUD_AGENT_KIND: undefined }, 'o/r', 'main'), null, 'a task run has no hub context');
  const ctx = hubContext(env, 'acme/app', 'main');
  assert.ok(ctx);
  const socket = join(mkdtempSync(join(tmpdir(), 'cloud-agent-hub-')), 'ask.sock');
  const channel = await openToolChannel(socket, ({ tool, input }) =>
    isHubTool(tool) ? callHubTool(ctx, tool, input) : Promise.resolve({ text: 'no', isError: true }),
  );
  const call: Call = (toolCall, timeoutMs) => callTool(socket, toolCall, timeoutMs);
  const tool = async (name: string, args: unknown) => {
    const reply = await handle('tools/call', { name, arguments: args }, call, true);
    assert.ok(reply && 'result' in reply);
    const result = reply.result as { content: { text: string }[]; isError: boolean };
    return { text: result.content[0]?.text ?? '', isError: result.isError };
  };
  try {
    const list = await handle('tools/list', {}, call, true);
    assert.ok(list && 'result' in list);
    assert.deepEqual(rec(list.result).tools.map((t) => t.name), [
      ASK_TOOL, 'create_child', 'list_children', 'get_child', 'reply_child', 'message_child', 'stop_child', 'read_state', 'write_state',
    ]);
    assert.deepEqual(await tool('create_child', { title: 'Add a', prompt: 'Add a', tier: 'flash', branch: 'cloud-agent/a' }), {
      text: JSON.stringify({ id: 'ag_child', parentId: 'ag_hub' }),
      isError: false,
    });
    assert.deepEqual(requests[0], {
      method: 'POST',
      url: '/api/cloud-agents/.backstage/actions/v1/actions/cloud-agents:create-agent/invoke',
      auth: 'Bearer cahub.run.1.sig',
      body: { repo: 'acme/app', base: 'main', title: 'Add a', prompt: 'Add a', tier: 'flash', branch: 'cloud-agent/a', kind: 'task' },
    });
    assert.deepEqual(await tool('list_children', {}), { text: JSON.stringify({ children: [{ id: 'ag_child' }] }), isError: false });
    assert.deepEqual(await tool('get_child', { id: 'ag_other' }), { text: 'not_your_child', isError: true });
    assert.deepEqual(await tool('message_child', { id: 'ag_child', text: 'more' }), { text: 'child_running', isError: true });
    assert.deepEqual(await tool('reply_child', { id: 'ag_child', questionId: 'ask-1', answer: 'yes' }), { text: 'missing_credential', isError: true });
    assert.deepEqual(await tool('stop_child', { id: 'ag_gone' }), { text: 'No agent ag_gone', isError: true });
    assert.deepEqual(await tool('write_state', { state: { plan: ['a'] } }), { text: '{}', isError: false });
    assert.deepEqual(requests.at(-1)?.body, { state: { plan: ['a'] } });
    assert.deepEqual(await tool('read_state', {}), { text: JSON.stringify({ state: { plan: ['a'] } }), isError: false });
    assert.ok(requests.every((r) => r.auth === 'Bearer cahub.run.1.sig'));
    assert.deepEqual(askCommand({ model: 'm', effort: 'e', prompt: 'p', workdir: '/w', home: '/h', askSocket: '/s', hub: true }).slice(-1), ['--hub']);
  } finally {
    await channel.close();
    server.close();
  }
});

test('ask_user still answers when no runner is listening', async () => {
  const call = await handle('tools/call', { name: ASK_TOOL, arguments: { question: 'Red or blue?' } }, (toolCall, timeoutMs) => callTool('/nonexistent/ask.sock', toolCall, timeoutMs));
  assert.ok(call && 'result' in call);
  assert.match(JSON.stringify(call.result), /did not acknowledge/);
});
