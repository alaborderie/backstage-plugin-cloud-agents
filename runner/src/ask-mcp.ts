import { createInterface } from 'node:readline';
import { callTool } from './ask-channel.ts';
import type { ToolCall, ToolReply } from './ask-channel.ts';
import { ASK_TOOL, ASK_TOOL_DESCRIPTION, NO_REPLY } from './harnesses/types.ts';
import { HUB_TOOLS } from './hub-tools.ts';
import { rec, str } from './json.ts';
import { runnerVersion } from './version.ts';

const ASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question, with the context a reader needs to answer it.' },
    options: {
      type: 'array',
      description: 'Suggested answers, recommended first.',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, description: { type: 'string' } },
        required: ['label'],
      },
    },
    blocking: { type: 'boolean', description: 'True when you cannot continue safely without the answer. Defaults to true.' },
  },
  required: ['question'],
};

const ASK_TOOL_ENTRY = { name: ASK_TOOL, description: ASK_TOOL_DESCRIPTION, inputSchema: ASK_INPUT_SCHEMA };

/** A hub tool call waits on the plugin, which may create a Job; ask_user only on the runner. */
const ASK_TIMEOUT_MS = 10_000;
const HUB_TIMEOUT_MS = 120_000;

type Reply = { result: unknown } | { error: { code: number; message: string } };
export type Call = (call: ToolCall, timeoutMs: number) => Promise<ToolReply | null>;

function noAnswer(tool: string): ToolReply {
  return tool === ASK_TOOL
    ? { text: `${NO_REPLY} (The runner did not acknowledge the question.)`, isError: false }
    : { text: 'The runner did not answer this call. Retry it.', isError: true };
}

/** The `cloud_agent` MCP server: ask_user, and on a hub run the hub tools. */
export async function handle(method: string, params: unknown, call: Call, hub = false): Promise<Reply | null> {
  const tools = hub ? [ASK_TOOL_ENTRY, ...HUB_TOOLS] : [ASK_TOOL_ENTRY];
  switch (method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: str(rec(params).protocolVersion) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'cloud-agent', version: runnerVersion() },
        },
      };
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools } };
    case 'tools/call': {
      const name = String(rec(params).name);
      if (!tools.some((t) => t.name === name)) return { error: { code: -32602, message: `unknown tool ${name}` } };
      const reply = (await call({ tool: name, input: rec(params).arguments }, name === ASK_TOOL ? ASK_TIMEOUT_MS : HUB_TIMEOUT_MS)) ?? noAnswer(name);
      return { result: { content: [{ type: 'text', text: reply.text }], isError: reply.isError } };
    }
    default:
      return method.startsWith('notifications/') ? null : { error: { code: -32601, message: `method not found: ${method}` } };
  }
}

export async function serveAsk(socketPath: string | null, hub: boolean): Promise<void> {
  const call: Call = (toolCall, timeoutMs) => (socketPath === null ? Promise.resolve(null) : callTool(socketPath, toolCall, timeoutMs));
  for await (const line of createInterface({ input: process.stdin })) {
    let msg: Record<string, unknown>;
    try {
      msg = rec(JSON.parse(line));
    } catch {
      continue;
    }
    const reply = await handle(str(msg.method) ?? '', msg.params, call, hub);
    if (reply !== null && msg.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply })}\n`);
  }
}
