import type {
  AgentKind,
  AgentStatus,
} from '@alaborderie/plugin-cloud-agents-common';

/** A conversation of one user, newest first in `GET /conversations`. */
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** The tools the chat model can call. */
export const TOOL_NAMES = [
  'search_catalog',
  'get_entity',
  'search_techdocs',
  'read_techdocs_page',
  'github_get',
  'list_agents',
  'get_agent',
  'create_agent',
  'reply_to_agent',
  'send_agent_message',
  'stop_agent',
  'ask_reasoning_model',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** One tool call the model asked for in an assistant item. */
export interface ToolCallRequest {
  id: string;
  name: string;
  /** The arguments as the model wrote them, a JSON string. */
  arguments: string;
}

interface ItemBase {
  id: string;
  conversationId: string;
  /** The item's position in its conversation, from 1. */
  seq: number;
  createdAt: string;
}

/** What the user typed. */
export interface UserItem extends ItemBase {
  type: 'user';
  text: string;
}

/**
 * One completion of the chat model: its text, and the tools it called. A turn
 * has one assistant item per model call; only the last one has no tool calls.
 */
export interface AssistantItem extends ItemBase {
  type: 'assistant';
  text: string;
  toolCalls: ToolCallRequest[];
  status: 'streaming' | 'done' | 'error';
  error: string | null;
}

/** One tool call and its result. */
export interface ToolItem extends ItemBase {
  type: 'tool';
  toolCallId: string;
  name: string;
  input: unknown;
  /** The JSON the tool returned, cut to about 20 KB. */
  output: unknown;
  status: 'running' | 'done' | 'error';
  error: string | null;
  durationMs: number | null;
}

/** A cloud agent or hub the chat launched. The page follows it live. */
export interface AgentItem extends ItemBase {
  type: 'agent';
  agentId: string;
  agentKind: AgentKind;
  title: string;
  repo: string;
}

/** What a launched agent did, written once the agent reached a terminal status. */
export interface AgentSummaryItem extends ItemBase {
  type: 'agent_summary';
  agentId: string;
  status: AgentStatus;
  prUrl: string | null;
  text: string;
}

export type ConversationItem =
  | UserItem
  | AssistantItem
  | ToolItem
  | AgentItem
  | AgentSummaryItem;

/** `GET /conversations/:id`. */
export interface ConversationDetail {
  conversation: Conversation;
  items: ConversationItem[];
}

/** Body of `POST /conversations/:id/messages`. */
export interface SendMessageRequest {
  text: string;
}

/**
 * The SSE events of `POST /conversations/:id/messages`, each as
 * `event: <type>` and `data: <JSON of the event>`.
 *
 * - `item`: an item was created or changed. Replace any item of the same id.
 * - `delta`: text to append to the streaming assistant item `itemId`.
 * - `done`: the turn ended; the stream closes.
 * - `error`: the turn failed; the stream closes.
 */
export type TurnEvent =
  | { type: 'item'; item: ConversationItem }
  | { type: 'delta'; itemId: string; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** `POST /conversations/:id/agents/:agentId/summary`. */
export interface SummaryResponse {
  /** The summary, or null while the agent is not terminal. */
  item: AgentSummaryItem | null;
}
