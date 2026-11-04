import type { EventBody, HarnessName } from '../events.ts';
import { arr, rec, str } from '../json.ts';

export interface RunSpec {
  model: string;
  effort: string;
  prompt: string;
  workdir: string;
  home: string;
  askSocket: string;
}

export interface Invocation {
  command: string;
  args: string[];
  stdin: string | null;
}

export interface Translator {
  translate(line: unknown): EventBody[];
  error(): string | null;
}

export interface Harness {
  name: HarnessName;
  binary: string;
  /** Writes per-run config under spec.home and returns the env the harness needs, credential included. Throws when the credential is missing. */
  prepare(spec: RunSpec, env: NodeJS.ProcessEnv): Record<string, string>;
  invocation(spec: RunSpec): Invocation;
  createTranslator(): Translator;
}

export const ASK_SERVER = 'cloud_agent';
export const ASK_TOOL = 'ask_user';

export function askCommand(spec: RunSpec): string[] {
  return ['cloud-agent', 'mcp-ask', '--socket', spec.askSocket];
}

export const ASK_TOOL_DESCRIPTION =
  'Ask the human operator a question. Use it whenever you would ask the user something, ' +
  'including where a skill says AskUserQuestion, request_user_input, or a question tool. ' +
  'No one answers during this run. Set blocking to true when you cannot continue safely without ' +
  'the answer: then stop, summarize your progress, and end your turn; the answer arrives in a ' +
  'follow-up run on the same branch. Set blocking to false when you can proceed with a stated default.';

function options(value: unknown): { label: string; description: string | null }[] {
  return arr(value).map((o) =>
    typeof o === 'string' ? { label: o, description: null } : { label: str(rec(o).label) ?? '', description: str(rec(o).description) },
  );
}

/** ask_user sends {question, options?, blocking?}; native question tools (AskUserQuestion, OpenCode question) send {questions: [...]}. */
export function questionEvents(callId: string, input: unknown, source: 'ask_user' | 'native'): EventBody[] {
  const value = rec(input);
  const items = Array.isArray(value.questions) ? value.questions.map(rec) : [value];
  return items.map((item, i) => ({
    type: 'question',
    question_id: items.length === 1 ? callId : `${callId}#${i}`,
    question: str(item.question) ?? JSON.stringify(item),
    options: options(item.options),
    blocking: source === 'ask_user' && item.blocking !== false,
    source,
  }));
}
