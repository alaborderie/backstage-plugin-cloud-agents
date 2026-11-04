import { createInterface } from 'node:readline';
import { sendQuestion } from './ask-channel.ts';
import type { AskReply } from './ask-channel.ts';
import { ASK_TOOL, ASK_TOOL_DESCRIPTION } from './harnesses/types.ts';
import { rec, str } from './json.ts';
import { runnerVersion } from './version.ts';

const INPUT_SCHEMA = {
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

const NO_REPLY =
  'Recorded. No one can answer during this run. If the question is blocking, stop now: summarize your ' +
  'progress and the question in your final message and end your turn. The answer will come in a follow-up ' +
  'run on the same branch. Otherwise continue with the default you stated.';

type Reply = { result: unknown } | { error: { code: number; message: string } };
type Ask = (input: unknown) => Promise<AskReply | null>;

function answerText(reply: AskReply | null): string {
  if (reply === null) return `${NO_REPLY} (The runner did not acknowledge the question.)`;
  return reply.answer === null ? NO_REPLY : `The operator answered: ${reply.answer}`;
}

export async function handle(method: string, params: unknown, ask: Ask): Promise<Reply | null> {
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
      return { result: { tools: [{ name: ASK_TOOL, description: ASK_TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA }] } };
    case 'tools/call':
      if (rec(params).name !== ASK_TOOL) return { error: { code: -32602, message: `unknown tool ${String(rec(params).name)}` } };
      return { result: { content: [{ type: 'text', text: answerText(await ask(rec(params).arguments)) }], isError: false } };
    default:
      return method.startsWith('notifications/') ? null : { error: { code: -32601, message: `method not found: ${method}` } };
  }
}

export async function serveAsk(socketPath: string | null): Promise<void> {
  const ask: Ask = (input) => (socketPath === null ? Promise.resolve(null) : sendQuestion(socketPath, input));
  for await (const line of createInterface({ input: process.stdin })) {
    let msg: Record<string, unknown>;
    try {
      msg = rec(JSON.parse(line));
    } catch {
      continue;
    }
    const reply = await handle(str(msg.method) ?? '', msg.params, ask);
    if (reply !== null && msg.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply })}\n`);
  }
}
