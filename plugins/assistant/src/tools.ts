import {
  RiBook2Line,
  RiBrainLine,
  RiGithubLine,
  RiRobot2Line,
  RiStackLine,
  RiToolsLine,
  type RemixiconComponentType,
} from '@remixicon/react';
import type { ToolItem, ToolName } from '@alaborderie/plugin-assistant-common';

export type ToolFamily =
  | 'catalog'
  | 'techdocs'
  | 'github'
  | 'agents'
  | 'reasoning'
  | 'other';

export const FAMILY_ICON: Record<ToolFamily, RemixiconComponentType> = {
  catalog: RiStackLine,
  techdocs: RiBook2Line,
  github: RiGithubLine,
  agents: RiRobot2Line,
  reasoning: RiBrainLine,
  other: RiToolsLine,
};

type Input = Record<string, unknown>;

/** The first string among `keys` of a tool's input. */
function pick(input: Input, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function forQuery(input: Input): string {
  const query = pick(input, 'query', 'term');
  return query ? ` for “${query}”` : '';
}

const named = (text: string | undefined) => (text ? ` ${text}` : '');

interface ToolCopy {
  family: ToolFamily;
  /** What the call is doing, then what it did. */
  verb: [running: string, done: string];
  /** What the call is about, from its input, such as ` for “rust”`. */
  detail?: (input: Input) => string;
}

const TOOLS: Record<ToolName, ToolCopy> = {
  search_catalog: {
    family: 'catalog',
    verb: ['Searching the catalog', 'Searched the catalog'],
    detail: forQuery,
  },
  get_entity: {
    family: 'catalog',
    verb: ['Reading', 'Read'],
    detail: i => named(pick(i, 'entityRef', 'ref') ?? 'a catalog entity'),
  },
  search_techdocs: {
    family: 'techdocs',
    verb: ['Searching TechDocs', 'Searched TechDocs'],
    detail: forQuery,
  },
  read_techdocs_page: {
    family: 'techdocs',
    verb: ['Reading TechDocs', 'Read TechDocs'],
    detail: i => named(pick(i, 'title', 'location', 'path', 'url')),
  },
  github_get: {
    family: 'github',
    verb: ['Reading GitHub', 'Read GitHub'],
    detail: i => named(pick(i, 'path', 'url')),
  },
  list_agents: {
    family: 'agents',
    verb: ['Listing your cloud agents', 'Listed your cloud agents'],
  },
  get_agent: {
    family: 'agents',
    verb: ['Checking agent', 'Checked agent'],
    detail: i => named(pick(i, 'agentId', 'id')),
  },
  create_agent: {
    family: 'agents',
    verb: ['Starting an agent', 'Started an agent'],
    detail: i => (pick(i, 'repo') ? ` on ${pick(i, 'repo')}` : ''),
  },
  reply_to_agent: {
    family: 'agents',
    verb: ['Answering agent', 'Answered agent'],
    detail: i => named(pick(i, 'agentId', 'id')),
  },
  send_agent_message: {
    family: 'agents',
    verb: ['Messaging agent', 'Messaged agent'],
    detail: i => named(pick(i, 'agentId', 'id')),
  },
  stop_agent: {
    family: 'agents',
    verb: ['Stopping agent', 'Stopped agent'],
    detail: i => named(pick(i, 'agentId', 'id')),
  },
  ask_reasoning_model: {
    family: 'reasoning',
    verb: ['Asking Claude Opus 5.5', 'Asked Claude Opus 5.5'],
  },
};

function copyOf(name: string): ToolCopy {
  return (
    (TOOLS as Record<string, ToolCopy | undefined>)[name] ?? {
      family: 'other',
      verb: [`Calling ${name}`, `Called ${name}`],
    }
  );
}

/** The input as an object; the backend may also hand over the model's JSON string. */
function parseInput(input: unknown): Input {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Input) : {};
}

export function toolFamily(name: string): ToolFamily {
  return copyOf(name).family;
}

/** One line for a tool call, such as “Searched the catalog for “rust””. */
export function toolLabel(item: Pick<ToolItem, 'name' | 'input' | 'status'>) {
  const copy = copyOf(item.name);
  const input = parseInput(item.input);
  const verb = copy.verb[item.status === 'running' ? 0 : 1];
  return `${verb}${copy.detail?.(input) ?? ''}`;
}

/** The markdown answer of `ask_reasoning_model`, when its output has one. */
export function reasoningAnswer(item: ToolItem): string | undefined {
  if (item.name !== 'ask_reasoning_model') return undefined;
  const output = item.output as { answer?: unknown } | null;
  return typeof output?.answer === 'string' ? output.answer : undefined;
}
