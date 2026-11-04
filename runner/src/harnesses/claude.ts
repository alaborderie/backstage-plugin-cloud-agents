import type { EventBody, ToolKind } from '../events.ts';
import { arr, clipInput, clipText, num, rec, str } from '../json.ts';
import { ASK_SERVER, askCommand, questionEvents } from './types.ts';
import type { Harness, Translator } from './types.ts';

const NATIVE_QUESTION = 'AskUserQuestion';

const KINDS: Record<string, ToolKind> = {
  Bash: 'shell',
  Read: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Glob: 'search',
  Grep: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'task',
  Agent: 'task',
};

function kindOf(name: string): ToolKind {
  return KINDS[name] ?? (name.startsWith('mcp__') ? 'mcp' : 'other');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .map((part) => str(rec(part).text) ?? '')
    .filter((t) => t !== '')
    .join('\n');
}

function rateLimitStatus(status: string | null): 'allowed' | 'warning' | 'limited' {
  if (status === 'allowed') return 'allowed';
  if (status === 'allowed_warning') return 'warning';
  return 'limited';
}

function createTranslator(): Translator {
  let failure: string | null = null;
  let sawResult = false;

  function translate(line: unknown): EventBody[] {
    const msg = rec(line);
    const parent = str(msg.parent_tool_use_id);
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') return [{ type: 'session.started', session_id: str(msg.session_id) ?? '', model: str(msg.model) }];
        return [];
      case 'assistant':
        return arr(rec(msg.message).content).flatMap((block): EventBody[] => {
          const b = rec(block);
          if (b.type === 'text' && str(b.text)) return [{ type: 'assistant.message', text: str(b.text) ?? '', parent_call_id: parent }];
          if (b.type !== 'tool_use') return [];
          const id = str(b.id) ?? '';
          const name = str(b.name) ?? '';
          const call: EventBody = { type: 'tool.call', call_id: id, name, kind: kindOf(name), input: clipInput(b.input ?? {}), parent_call_id: parent };
          return name === NATIVE_QUESTION ? [call, ...questionEvents(id, b.input, 'native')] : [call];
        });
      case 'user':
        return arr(rec(msg.message).content).flatMap((block): EventBody[] => {
          const b = rec(block);
          const id = str(b.tool_use_id);
          if (b.type !== 'tool_result' || id === null) return [];
          const { text, truncated } = clipText(resultText(b.content));
          return [{ type: 'tool.result', call_id: id, is_error: b.is_error === true, output: text, truncated, parent_call_id: parent }];
        });
      case 'rate_limit_event': {
        const info = rec(msg.rate_limit_info);
        const window = str(info.rateLimitType);
        const resetsAt = num(info.resetsAt);
        const windowInfo = window ? rec(rec(info.unifiedWindows)[window]) : {};
        return [
          {
            type: 'rate_limit',
            status: rateLimitStatus(str(info.status)),
            window,
            resets_at: resetsAt > 0 ? new Date(resetsAt * 1000).toISOString() : null,
            utilization: typeof windowInfo.utilization === 'number' ? windowInfo.utilization : null,
            message: null,
          },
        ];
      }
      case 'result': {
        sawResult = true;
        if (msg.is_error === true || msg.subtype !== 'success') {
          failure = str(msg.result) ?? `claude result: ${str(msg.subtype) ?? 'error'}`;
        }
        const usage = rec(msg.usage);
        return [
          {
            type: 'usage',
            input_tokens: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
            output_tokens: num(usage.output_tokens),
            cached_input_tokens: num(usage.cache_read_input_tokens),
            reasoning_tokens: num(rec(usage.output_tokens_details).thinking_tokens),
            cost_usd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
          },
        ];
      }
      default:
        return [];
    }
  }

  return {
    translate,
    error: () => failure ?? (sawResult ? null : 'claude exited without a result event'),
  };
}

export const claude: Harness = {
  name: 'claude',
  binary: 'claude',
  prepare(_spec, env) {
    const token = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw new Error('claude needs CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`)');
    return { CLAUDE_CODE_OAUTH_TOKEN: token };
  },
  invocation(spec) {
    const [command, ...args] = askCommand(spec);
    const mcp = { mcpServers: { [ASK_SERVER]: { type: 'stdio', command, args } } };
    return {
      command: 'claude',
      args: [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--model', spec.model,
        '--effort', spec.effort,
        '--permission-mode', 'bypassPermissions',
        '--mcp-config', JSON.stringify(mcp),
      ],
      stdin: spec.prompt,
    };
  },
  createTranslator,
};
