import type { ToolReply } from './ask-channel.ts';
import { rec, str } from './json.ts';

/** Where a hub run reaches the plugin, and the defaults its children take. */
export interface HubContext {
  apiUrl: string;
  runToken: string;
  repo: string;
  base: string;
}

/** Set by the plugin on a hub run only. */
export const KIND_ENV = 'CLOUD_AGENT_KIND';
export const API_URL_ENV = 'CLOUD_AGENT_API_URL';

const FETCH_TIMEOUT_MS = 60_000;

const id = { type: 'string', description: 'The child agent id, ag_...' };

/** The hub tools of docs/API.md "Hub tools in the pod", next to ask_user on a hub run. */
export const HUB_TOOLS = [
  {
    name: 'create_child',
    description:
      'Start a child cloud agent of this hub. It works on its own branch and opens a pull request. repo and base default to the hub’s; ' +
      'branch defaults to cloud-agent/<short id>, give it to continue a branch. Returns the child agent object.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string', description: 'The full brief of the child.' },
        tier: { type: 'string', enum: ['flash', 'sol', 'opus'] },
        repo: { type: 'string', description: 'owner/name' },
        base: { type: 'string' },
        branch: { type: 'string' },
      },
      required: ['title', 'prompt', 'tier'],
    },
  },
  {
    name: 'list_children',
    description: 'List the children of this hub with their status, open questions, branch, and pull request.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_child',
    description: 'Read one child: the agent object and lastMessage, its last assistant message of its last run (or null).',
    inputSchema: { type: 'object', properties: { id }, required: ['id'] },
  },
  {
    name: 'reply_child',
    description: 'Answer an open question of a child that is needs_input. The answer that completes the set starts its next run.',
    inputSchema: {
      type: 'object',
      properties: { id, questionId: { type: 'string' }, answer: { type: 'string' } },
      required: ['id', 'questionId', 'answer'],
    },
  },
  {
    name: 'message_child',
    description: 'Start a follow-up run of a child that has no active run, on its branch. Fails with child_running otherwise.',
    inputSchema: { type: 'object', properties: { id, text: { type: 'string' } }, required: ['id', 'text'] },
  },
  {
    name: 'stop_child',
    description: 'Stop a child. A stop that the hub requests does not wake the hub.',
    inputSchema: { type: 'object', properties: { id }, required: ['id'] },
  },
  {
    name: 'read_state',
    description: 'Read the JSON this hub last wrote with write_state, or null. Use it to keep the plan between runs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'write_state',
    description: 'Store any JSON value (at most 64 KiB) as the hub’s plan for its next runs. No file survives the pod.',
    inputSchema: { type: 'object', properties: { state: { description: 'Any JSON value.' } }, required: ['state'] },
  },
] as const;

export type HubToolName = (typeof HUB_TOOLS)[number]['name'];

export function isHubTool(name: string): name is HubToolName {
  return HUB_TOOLS.some((t) => t.name === name);
}

/** The hub context of this run, or null on a task run. */
export function hubContext(env: NodeJS.ProcessEnv, repo: string, base: string): HubContext | null {
  const apiUrl = env[API_URL_ENV];
  const runToken = env.CLOUD_AGENT_RUN_TOKEN;
  if (env[KIND_ENV] !== 'hub' || !apiUrl || !runToken) return null;
  return { apiUrl: apiUrl.replace(/\/$/, ''), runToken, repo, base };
}

async function request(ctx: HubContext, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${ctx.apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ctx.runToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
  } catch {
    return { status: response.status, body: text };
  }
}

/** The tool error of docs/API.md for a refused call. */
function failure(tool: HubToolName, status: number, body: unknown): ToolReply {
  const error = rec(rec(body).error);
  const message = str(error.message) ?? str(rec(body).error) ?? `HTTP ${String(status)}`;
  if (message === 'not_your_child') return { text: 'not_your_child', isError: true };
  if (status === 409 && tool === 'message_child') return { text: 'child_running', isError: true };
  if (status === 422 || error.name === 'MissingCredentialError') return { text: 'missing_credential', isError: true };
  return { text: message, isError: true };
}

async function action(ctx: HubContext, tool: HubToolName, name: string, input: Record<string, unknown>): Promise<{ ok: true; output: Record<string, unknown> } | { ok: false; reply: ToolReply }> {
  const { status, body } = await request(ctx, 'POST', `/.backstage/actions/v1/actions/cloud-agents:${name}/invoke`, input);
  if (status !== 200) return { ok: false, reply: failure(tool, status, body) };
  return { ok: true, output: rec(rec(body).output) };
}

function json(value: unknown): ToolReply {
  return { text: JSON.stringify(value), isError: false };
}

/** One hub tool call, through the plugin's cloud-agents actions and its hub state route. */
export async function callHubTool(ctx: HubContext, tool: HubToolName, raw: unknown): Promise<ToolReply> {
  const input = rec(raw);
  const pick = (...keys: string[]) => Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
  const agentOf = async (name: string, args: Record<string, unknown>): Promise<ToolReply> => {
    const result = await action(ctx, tool, name, args);
    return result.ok ? json(result.output.agent) : result.reply;
  };
  switch (tool) {
    case 'create_child':
      return agentOf('create-agent', { repo: ctx.repo, base: ctx.base, ...pick('title', 'prompt', 'tier', 'repo', 'base', 'branch'), kind: 'task' });
    case 'list_children': {
      const result = await action(ctx, tool, 'list-agents', {});
      return result.ok ? json({ children: result.output.agents }) : result.reply;
    }
    case 'get_child': {
      const result = await action(ctx, tool, 'get-agent', pick('id'));
      return result.ok ? json(result.output) : result.reply;
    }
    case 'reply_child':
      return agentOf('reply-to-agent', pick('id', 'questionId', 'answer'));
    case 'message_child':
      return agentOf('send-agent-message', pick('id', 'text'));
    case 'stop_child':
      return agentOf('stop-agent', pick('id'));
    case 'read_state': {
      const { status, body } = await request(ctx, 'GET', '/runner/hub/state');
      return status === 200 ? json({ state: rec(body).state ?? null }) : failure(tool, status, body);
    }
    case 'write_state': {
      const { status, body } = await request(ctx, 'PUT', '/runner/hub/state', { state: input.state ?? null });
      return status === 200 ? json({}) : failure(tool, status, body);
    }
  }
}
