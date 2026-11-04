import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBody, ToolKind } from '../events.ts';
import { clipInput, clipText, num, rec, str } from '../json.ts';
import { ASK_SERVER, askCommand, questionEvents } from './types.ts';
import type { Harness, Translator } from './types.ts';

const NATIVE_QUESTION = 'question';

const KINDS: Record<string, ToolKind> = {
  shell: 'shell',
  bash: 'shell',
  read: 'read',
  write: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  patch: 'edit',
  apply_patch: 'edit',
  glob: 'search',
  grep: 'search',
  list: 'search',
  webfetch: 'web',
  websearch: 'web',
  task: 'task',
};

function createTranslator(): Translator {
  let sessionId: string | null = null;
  let failure: string | null = null;

  function translate(line: unknown): EventBody[] {
    const msg = rec(line);
    const part = rec(msg.part);
    const events: EventBody[] = [];
    const sid = str(msg.sessionID);
    if (sid && sessionId === null) {
      sessionId = sid;
      events.push({ type: 'session.started', session_id: sid, model: null });
    }
    switch (msg.type) {
      case 'text': {
        const text = str(part.text);
        if (text) events.push({ type: 'assistant.message', text, parent_call_id: null });
        break;
      }
      case 'tool_use': {
        const id = str(part.id) ?? str(part.partID) ?? '';
        const name = str(part.tool) ?? '';
        const state = rec(part.state);
        const isError = state.status === 'error';
        const { text, truncated } = clipText(str(isError ? state.error : state.output) ?? '');
        events.push(
          { type: 'tool.call', call_id: id, name, kind: KINDS[name] ?? 'other', input: clipInput(state.input ?? {}), parent_call_id: null },
          { type: 'tool.result', call_id: id, is_error: isError, output: text, truncated, parent_call_id: null },
        );
        if (name === NATIVE_QUESTION) events.push(...questionEvents(id, state.input, 'native'));
        break;
      }
      case 'step_finish': {
        const tokens = rec(part.tokens);
        const cache = rec(tokens.cache);
        events.push({
          type: 'usage',
          input_tokens: num(tokens.input) + num(cache.read) + num(cache.write),
          output_tokens: num(tokens.output),
          cached_input_tokens: num(cache.read),
          reasoning_tokens: num(tokens.reasoning),
          cost_usd: typeof part.cost === 'number' ? part.cost : null,
        });
        break;
      }
      case 'error': {
        const error = rec(msg.error);
        const message = str(error.message) ?? str(rec(error.data).message) ?? 'opencode error';
        failure = message;
        if (error.status === 429 || /rate limit|usage limit/i.test(message)) {
          events.push({ type: 'rate_limit', status: 'limited', window: null, resets_at: null, utilization: null, message });
        }
        events.push({ type: 'log', level: 'error', source: 'harness', message });
        break;
      }
      default:
        break;
    }
    return events;
  }

  return { translate, error: () => failure };
}

export const opencode: Harness = {
  name: 'opencode',
  binary: 'opencode',
  prepare(spec, env) {
    const key = env.OPENCODE_API_KEY;
    if (!key) throw new Error('opencode needs OPENCODE_API_KEY (an OpenCode Go key from the OpenCode console)');
    const dir = join(spec.home, '.cache', 'cloud-agent');
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'opencode.json');
    const config = { mcp: { [ASK_SERVER]: { type: 'local', command: askCommand(spec), enabled: true } } };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return { OPENCODE_API_KEY: key, OPENCODE_CONFIG: configPath };
  },
  invocation(spec) {
    return {
      command: 'opencode',
      args: ['run', '--standalone', '--auto', '--format', 'json', '--model', `${spec.model}#${spec.effort}`, spec.prompt],
      stdin: null,
    };
  },
  createTranslator,
};
