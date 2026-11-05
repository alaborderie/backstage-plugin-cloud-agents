import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef } from '@backstage/backend-plugin-api/alpha';
import {
  actionsRegistryServiceFactory,
  actionsServiceFactory,
} from '@backstage/backend-defaults/alpha';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
  TestDatabases,
  type TestBackend,
} from '@backstage/backend-test-utils';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import type {
  ConversationDetail,
  ConversationItem,
  TurnEvent,
} from '@alaborderie/plugin-assistant-common';
import { assistantPlugin } from './plugin';

jest.setTimeout(30_000);

const ALICE = mockCredentials.user.header('user:default/alice');
const BOB = mockCredentials.user.header('user:default/bob');

type Script =
  | { text: string }
  | { toolCall: { name: string; arguments: object } };

/** An OpenAI-compatible endpoint that streams one scripted reply per call. */
class FakeChatModel {
  readonly requests: any[] = [];
  readonly script: Script[] = [];
  server!: Server;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        this.requests.push({ headers: req.headers, body: JSON.parse(body) });
        const next = this.script.shift() ?? { text: 'Done.' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta: object) =>
          res.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`,
          );
        if ('text' in next) {
          for (const word of next.text.split(/(?<= )/)) {
            chunk({ content: word });
          }
        } else {
          const args = JSON.stringify(next.toolCall.arguments);
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_${this.requests.length}`,
                type: 'function',
                function: { name: next.toolCall.name, arguments: '' },
              },
            ],
          });
          chunk({
            tool_calls: [{ index: 0, function: { arguments: args } }],
          });
        }
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolve => this.server.listen(0, resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
}

const agents = new Map<string, Record<string, unknown>>();

const OAUTH_TOKEN = 'sk-ant-oat01-SECRET-alice';
let reasoningCredential: object | null = null;

/**
 * Stands in for the Claude Code CLI: records how it was started next to
 * itself, then prints the JSON result `claude --print` would.
 */
const fakeClaudeDir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
const fakeClaude = join(fakeClaudeDir, 'claude');
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', d => { input += d; }).on('end', () => {
  fs.writeFileSync(${JSON.stringify(
    join(fakeClaudeDir, 'call.json'),
  )}, JSON.stringify({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    cwdEntries: fs.readdirSync(process.cwd()),
    input,
  }));
  process.stdout.write(JSON.stringify({
    type: 'result',
    is_error: false,
    result: 'Nobody knows yet.',
    modelUsage: { 'claude-opus-5-5': {} },
  }));
});
`,
  { mode: 0o755 },
);

/** Stands in for cloud-agents: its actions and its credential route. */
const fakeCloudAgents = createBackendPlugin({
  pluginId: 'cloud-agents',
  register(env) {
    env.registerInit({
      deps: {
        registry: actionsRegistryServiceRef,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
      },
      async init({ registry, httpRouter, httpAuth }) {
        const agentOutput = (z: any) => z.object({}).passthrough();
        registry.register({
          name: 'create-agent',
          title: 'Create',
          description: 'Create',
          schema: {
            input: z =>
              z.object({
                repo: z.string(),
                prompt: z.string(),
                tier: z.string(),
                title: z.string().optional(),
                kind: z.enum(['task', 'hub']).optional(),
              }),
            output: z => z.object({ agent: agentOutput(z) }),
          },
          action: async ({ input, credentials }) => {
            const agent = {
              id: `ag_${agents.size + 1}`,
              kind: input.kind ?? 'task',
              title: input.title ?? 'Agent',
              repo: input.repo,
              branch: 'cloud-agent/x',
              status: 'running',
              prUrl: null,
              parentId: null,
              updatedAt: '2026-11-05T00:00:00Z',
              activity: null,
              openQuestions: [],
              children: [],
              owner: (credentials.principal as any).userEntityRef,
            };
            agents.set(agent.id, agent);
            return { output: { agent } };
          },
        });
        registry.register({
          name: 'get-agent',
          title: 'Get',
          description: 'Get',
          attributes: { readOnly: true },
          schema: {
            input: z => z.object({ id: z.string() }),
            output: z =>
              z.object({
                agent: agentOutput(z),
                lastMessage: z.string().nullable(),
              }),
          },
          action: async ({ input }) => ({
            output: {
              agent: agents.get(input.id)!,
              lastMessage: 'Opened the pull request.',
            },
          }),
        });
        const router = express.Router();
        router.use(express.json());
        router.post('/service/reasoning-credential', async (req, res) => {
          const creds = await httpAuth.credentials(req, { allow: ['service'] });
          res.json({
            credential:
              creds.principal.subject === 'plugin:assistant'
                ? reasoningCredential
                : 'wrong',
          });
        });
        httpRouter.use(router);
      },
    });
  },
});

const databases = TestDatabases.create({
  ids: ['SQLITE_3', 'POSTGRES_16'],
});

describe.each(databases.eachSupportedId())(
  'assistant backend on %s',
  databaseId => {
    let backend: TestBackend;
    let baseUrl: string;
    const model = new FakeChatModel();

    beforeAll(async () => {
      const modelUrl = await model.start();
      backend = await startTestBackend({
        features: [
          mockServices.database.factory({
            knex: await databases.init(databaseId),
          }),
          assistantPlugin,
          fakeCloudAgents,
          actionsRegistryServiceFactory,
          actionsServiceFactory,
          catalogServiceMock.factory({
            entities: [
              {
                apiVersion: 'backstage.io/v1alpha1',
                kind: 'Component',
                metadata: { name: 'keyroll', description: 'Rust key rotation' },
                spec: { type: 'service', owner: 'user:default/alice' },
              },
            ],
          }),
          mockServices.rootConfig.factory({
            data: {
              backend: { actions: { pluginSources: ['cloud-agents'] } },
              assistant: {
                chatModel: { apiKey: 'test-key', baseUrl: modelUrl },
                reasoningModel: { claudePath: fakeClaude },
              },
            },
          }),
        ],
      });
      const { port } = backend.server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}/api/assistant`;
    });

    afterAll(async () => {
      await backend.stop();
      model.server.close();
    });

    async function api(
      method: string,
      path: string,
      body?: unknown,
      auth = ALICE,
    ) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: auth,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    }

    async function send(id: string, text: string): Promise<TurnEvent[]> {
      const response = await fetch(`${baseUrl}/conversations/${id}/messages`, {
        method: 'POST',
        headers: { Authorization: ALICE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      return (await response.text()).split('\n\n').flatMap(block => {
        const data = block.split('\n').find(line => line.startsWith('data: '));
        return data ? [JSON.parse(data.slice(6)) as TurnEvent] : [];
      });
    }

    const itemsOf = (events: TurnEvent[]) =>
      new Map(
        events.flatMap(e => (e.type === 'item' ? [[e.item.id, e.item]] : [])),
      );

    it('streams a turn that calls a tool, stores it, and lists the conversation', async () => {
      model.script.push(
        { toolCall: { name: 'search_catalog', arguments: { query: 'rust' } } },
        { text: 'keyroll is your Rust service.' },
      );
      const { body: conversation } = await api('POST', '/conversations', {});

      const events = await send(conversation.id, 'Which service is in Rust?');
      expect(events[0]).toMatchObject({
        type: 'item',
        item: { type: 'user', text: 'Which service is in Rust?' },
      });
      const streamed = events
        .flatMap(e => (e.type === 'delta' ? [e.text] : []))
        .join('');
      expect(streamed).toBe('keyroll is your Rust service.');
      expect(events.at(-1)).toEqual({ type: 'done' });

      const { body: detail } = (await api(
        'GET',
        `/conversations/${conversation.id}`,
      )) as { body: ConversationDetail };
      expect(detail.items.map(i => i.type)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
      ]);
      expect([...itemsOf(events).values()]).toEqual(
        expect.arrayContaining(detail.items),
      );
      const tool = detail.items[2] as Extract<
        ConversationItem,
        { type: 'tool' }
      >;
      expect(tool).toMatchObject({
        name: 'search_catalog',
        input: { query: 'rust' },
        status: 'done',
      });
      expect(JSON.stringify(tool.output)).toContain(
        'Component:default/keyroll',
      );

      const lastRequest = model.requests.at(-1);
      expect(lastRequest.headers['x-opencode-session']).toBe(conversation.id);
      expect(lastRequest.body.thinking).toEqual({ type: 'disabled' });
      expect(lastRequest.body.messages[0].content).toContain(
        'Component:default/keyroll | service | user:default/alice | Rust key rotation',
      );
      expect(lastRequest.body.messages.map((m: any) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
      ]);

      const { body: list } = await api('GET', '/conversations');
      expect(list.conversations[0]).toMatchObject({
        id: conversation.id,
        title: 'Which service is in Rust?',
      });
      expect((await api('GET', '/conversations', undefined, BOB)).body).toEqual(
        {
          conversations: [],
        },
      );
      expect(
        (await api('GET', `/conversations/${conversation.id}`, undefined, BOB))
          .status,
      ).toBe(404);
    });

    it('launches an agent as the user, shows its card, and summarizes it once it is terminal', async () => {
      model.script.push(
        {
          toolCall: {
            name: 'create_agent',
            arguments: {
              repo: 'alaborderie/cloud-agent-runner-sandbox',
              prompt: 'Add CONTRIBUTING.md',
              title: 'Add CONTRIBUTING.md',
            },
          },
        },
        { text: 'I launched an agent.' },
      );
      const { body: conversation } = await api('POST', '/conversations', {});
      const events = await send(conversation.id, 'Add a CONTRIBUTING.md');
      const card = [...itemsOf(events).values()].find(i => i.type === 'agent');
      expect(card).toMatchObject({
        type: 'agent',
        agentKind: 'task',
        title: 'Add CONTRIBUTING.md',
        repo: 'alaborderie/cloud-agent-runner-sandbox',
      });
      const agentId = (card as { agentId: string }).agentId;
      expect(agents.get(agentId)).toMatchObject({
        owner: 'user:default/alice',
      });

      const summaryPath = `/conversations/${conversation.id}/agents/${agentId}/summary`;
      expect((await api('POST', summaryPath)).body).toEqual({ item: null });

      agents.get(agentId)!.status = 'succeeded';
      agents.get(agentId)!.prUrl = 'https://github.com/o/r/pull/7';
      model.script.push({ text: 'It added CONTRIBUTING.md in PR 7.' });
      const [first, second] = await Promise.all([
        api('POST', summaryPath),
        api('POST', summaryPath),
      ]);
      expect(first.body.item).toMatchObject({
        type: 'agent_summary',
        agentId,
        status: 'succeeded',
        prUrl: 'https://github.com/o/r/pull/7',
        text: 'It added CONTRIBUTING.md in PR 7.',
      });
      expect(second.body.item.id).toBe(first.body.item.id);
      expect((await api('POST', summaryPath)).body.item.id).toBe(
        first.body.item.id,
      );
      expect(
        (
          await api(
            'POST',
            `/conversations/${conversation.id}/agents/ag_none/summary`,
          )
        ).status,
      ).toBe(404);
    });

    it('answers the reasoning tool through Claude Code with the Claude Code token, isolated', async () => {
      reasoningCredential = { kind: 'claude_code', oauthToken: OAUTH_TOKEN };
      process.env.BACKEND_ONLY_SECRET = 'must-not-reach-claude';
      model.script.push(
        {
          toolCall: {
            name: 'ask_reasoning_model',
            arguments: { question: 'Is P equal to NP?', context: 'No proof.' },
          },
        },
        { text: 'Opus says nobody knows.' },
      );
      try {
        const { body: conversation } = await api('POST', '/conversations', {});
        const events = await send(conversation.id, 'Ask Opus about P vs NP');
        const tool = [...itemsOf(events).values()].find(i => i.type === 'tool');
        expect(tool).toMatchObject({
          status: 'done',
          output: {
            answer: 'Nobody knows yet.',
            model: 'claude-opus-5-5',
            credential: 'claude_code',
          },
        });
        const stored = await api('GET', `/conversations/${conversation.id}`);
        expect(JSON.stringify(stored.body)).not.toContain(OAUTH_TOKEN);
      } finally {
        reasoningCredential = null;
        delete process.env.BACKEND_ONLY_SECRET;
      }

      const call = JSON.parse(
        readFileSync(join(fakeClaudeDir, 'call.json'), 'utf8'),
      );
      expect(call.input).toBe(
        'Is P equal to NP?\n\n<context>\nNo proof.\n</context>',
      );
      expect(call.argv).toEqual(
        expect.arrayContaining(['--print', '--model', 'claude-opus-5-5']),
      );
      expect(call.argv[call.argv.indexOf('--tools') + 1]).toBe('');
      expect(call.argv).toContain('--strict-mcp-config');
      expect(call.argv[call.argv.indexOf('--setting-sources') + 1]).toBe('');
      expect(
        Object.keys(call.env)
          .filter(name => name !== 'PWD')
          .sort(),
      ).toEqual([
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CONFIG_DIR',
        'DISABLE_AUTOUPDATER',
        'HOME',
        'PATH',
        'TMPDIR',
      ]);
      expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH_TOKEN);
      expect(call.cwdEntries).toEqual([]);
      expect(call.env.HOME.startsWith(call.env.TMPDIR)).toBe(true);
      expect(call.env.CLAUDE_CONFIG_DIR.startsWith(call.env.HOME)).toBe(true);
      expect(call.cwd.startsWith(call.env.TMPDIR)).toBe(true);
      expect(() => readdirSync(call.env.TMPDIR)).toThrow(/ENOENT/);
    });

    it('tells the user how to add a Claude Code credential when the reasoning tool has none', async () => {
      model.script.push(
        {
          toolCall: {
            name: 'ask_reasoning_model',
            arguments: { question: 'Is P equal to NP?' },
          },
        },
        { text: 'Add a key first.' },
      );
      const { body: conversation } = await api('POST', '/conversations', {});
      const events = await send(conversation.id, 'Ask Opus about P vs NP');
      const tool = [...itemsOf(events).values()].find(i => i.type === 'tool');
      expect(tool).toMatchObject({
        name: 'ask_reasoning_model',
        status: 'done',
        output: { error: 'missing_claude_credential' },
      });
      expect(JSON.stringify((tool as any).output)).toContain(
        'claude setup-token',
      );
    });

    it('reports a tool error to the model instead of failing the turn', async () => {
      model.script.push(
        { toolCall: { name: 'get_entity', arguments: { nope: 1 } } },
        { text: 'That failed.' },
      );
      const { body: conversation } = await api('POST', '/conversations', {});
      const events = await send(conversation.id, 'Show an entity');
      const tool = [...itemsOf(events).values()].find(i => i.type === 'tool');
      expect(tool).toMatchObject({ status: 'error' });
      expect(events.at(-1)).toEqual({ type: 'done' });
      const toolMessage = model.requests
        .at(-1)
        .body.messages.find((m: any) => m.role === 'tool');
      expect(toolMessage.content).toContain('Invalid input');
    });
  },
);
