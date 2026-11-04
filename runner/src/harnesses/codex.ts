import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBody, ToolKind } from '../events.ts';
import { arr, clipInput, clipText, num, rec, str } from '../json.ts';
import type { Json } from '../json.ts';
import { ASK_SERVER, askCommand } from './types.ts';
import type { Harness, Translator } from './types.ts';

interface ToolItem {
  name: string;
  kind: ToolKind;
  input: unknown;
}

function toolItem(item: Json): ToolItem | null {
  switch (item.type) {
    case 'command_execution':
      return { name: 'shell', kind: 'shell', input: { command: item.command } };
    case 'file_change':
      return { name: 'apply_patch', kind: 'edit', input: { changes: item.changes } };
    case 'mcp_tool_call':
      return { name: `${str(item.server) ?? ''}/${str(item.tool) ?? ''}`, kind: 'mcp', input: item.arguments ?? {} };
    case 'web_search':
      return { name: 'web_search', kind: 'web', input: { query: item.query } };
    case 'collab_tool_call':
      return { name: str(item.tool) ?? 'collab', kind: 'task', input: { prompt: item.prompt, receivers: item.receiver_thread_ids } };
    default:
      return null;
  }
}

function toolOutput(item: Json): { output: string; isError: boolean } {
  const failed = item.status === 'failed' || item.status === 'declined';
  switch (item.type) {
    case 'command_execution':
      return { output: str(item.aggregated_output) ?? '', isError: failed || (typeof item.exit_code === 'number' && item.exit_code !== 0) };
    case 'file_change':
      return { output: arr(item.changes).map((c) => `${str(rec(c).kind) ?? 'update'} ${str(rec(c).path) ?? ''}`).join('\n'), isError: failed };
    case 'mcp_tool_call': {
      const error = str(rec(item.error).message);
      if (error) return { output: error, isError: true };
      const content = arr(rec(item.result).content).map((c) => str(rec(c).text) ?? '').join('\n');
      return { output: content, isError: failed };
    }
    default:
      return { output: '', isError: failed };
  }
}

function createTranslator(): Translator {
  const started = new Set<string>();
  let failure: string | null = null;
  let completed = false;

  function call(id: string, item: Json): EventBody[] {
    if (started.has(id)) return [];
    started.add(id);
    const tool = toolItem(item);
    return tool ? [{ type: 'tool.call', call_id: id, name: tool.name, kind: tool.kind, input: clipInput(tool.input), parent_call_id: null }] : [];
  }

  function translate(line: unknown): EventBody[] {
    const msg = rec(line);
    const item = rec(msg.item);
    const id = str(item.id) ?? '';
    switch (msg.type) {
      case 'thread.started':
        return [{ type: 'session.started', session_id: str(msg.thread_id) ?? '', model: null }];
      case 'item.started':
        return call(id, item);
      case 'item.completed': {
        if (item.type === 'agent_message') return [{ type: 'assistant.message', text: str(item.text) ?? '', parent_call_id: null }];
        if (item.type === 'error') return [{ type: 'log', level: 'warn', source: 'harness', message: str(item.message) ?? 'codex error item' }];
        if (!toolItem(item)) return [];
        const events = call(id, item);
        const { output, isError } = toolOutput(item);
        const { text, truncated } = clipText(output);
        return [...events, { type: 'tool.result', call_id: id, is_error: isError, output: text, truncated, parent_call_id: null }];
      }
      case 'turn.completed': {
        completed = true;
        failure = null;
        const usage = rec(msg.usage);
        return [
          {
            type: 'usage',
            input_tokens: num(usage.input_tokens),
            output_tokens: num(usage.output_tokens),
            cached_input_tokens: num(usage.cached_input_tokens),
            reasoning_tokens: num(usage.reasoning_output_tokens),
            cost_usd: null,
          },
        ];
      }
      case 'turn.failed':
        failure = str(rec(msg.error).message) ?? 'codex turn failed';
        return [{ type: 'log', level: 'error', source: 'harness', message: failure }];
      case 'error': {
        const message = str(msg.message) ?? 'codex error';
        failure = message;
        const events: EventBody[] = [{ type: 'log', level: 'error', source: 'harness', message }];
        if (/rate limit|usage limit|429/i.test(message)) {
          events.unshift({ type: 'rate_limit', status: 'limited', window: null, resets_at: null, utilization: null, message });
        }
        return events;
      }
      default:
        return [];
    }
  }

  return { translate, error: () => failure ?? (completed ? null : 'codex exited without completing a turn') };
}

export const codex: Harness = {
  name: 'codex',
  binary: 'codex',
  prepare(spec, env) {
    const codexHome = join(spec.home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const apiKey = env.CODEX_API_KEY ?? env.OPENAI_API_KEY;
    if (apiKey) return { CODEX_HOME: codexHome, CODEX_API_KEY: apiKey };
    if (env.CODEX_AUTH_JSON) {
      const target = join(codexHome, 'auth.json');
      copyFileSync(env.CODEX_AUTH_JSON, target);
      chmodSync(target, 0o600);
      return { CODEX_HOME: codexHome };
    }
    throw new Error('codex needs CODEX_API_KEY or OPENAI_API_KEY, or CODEX_AUTH_JSON pointing to a ChatGPT auth.json');
  },
  invocation(spec) {
    const [command, ...args] = askCommand(spec);
    return {
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--model', spec.model,
        '-c', `model_reasoning_effort="${spec.effort}"`,
        '-c', `mcp_servers.${ASK_SERVER}.command=${JSON.stringify(command)}`,
        '-c', `mcp_servers.${ASK_SERVER}.args=${JSON.stringify(args)}`,
        '--dangerously-bypass-approvals-and-sandbox',
        '--cd', spec.workdir,
        '-',
      ],
      stdin: spec.prompt,
    };
  },
  createTranslator,
};
