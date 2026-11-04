import type { Harness, RunnerEvent, ToolKind } from './events';

/** docs/API.md "Agents and runs". */
export type AgentStatus =
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'succeeded'
  | 'failed'
  | 'stopped';

export const AGENT_STATUSES: readonly AgentStatus[] = [
  'queued',
  'running',
  'needs_input',
  'succeeded',
  'failed',
  'stopped',
];

/** Statuses after which the event stream closes. `needs_input` is not one. */
export const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = [
  'succeeded',
  'failed',
  'stopped',
];

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return TERMINAL_AGENT_STATUSES.includes(status);
}

export type RunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'needs_input'
  | 'stopped';

/** Why a run started: the agent's creation, an answer, or a follow-up message. */
export type RunReason = 'initial' | 'reply' | 'message';

export type Tier = string;

export interface AgentParent {
  source: string;
  threadId?: string;
  label?: string;
}

/** Body of `POST /agents`. Give `tier`, or `harness` and `model`. */
export interface CreateAgentRequest {
  repo: string;
  base?: string;
  branch?: string;
  prompt: string;
  title?: string;
  tier?: Tier;
  harness?: Harness;
  model?: string;
  effort?: string;
  parent?: AgentParent;
}

export interface AgentRun {
  id: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

export interface OpenQuestion {
  questionId: string;
  runId: string;
  question: string;
  options: string[];
}

/**
 * What the agent did last: its latest tool call or assistant message. One
 * line, for list rows and widgets; the event stream has the full text.
 */
export type AgentActivity =
  | {
      type: 'tool.call';
      name: string;
      kind: ToolKind;
      /** What the call does, such as the command or the file path. */
      summary: string;
      /** The runner event's `ts`. */
      ts: string;
    }
  | {
      type: 'assistant.message';
      /** The message's first line, at most 200 characters. */
      text: string;
      ts: string;
    };

export interface Agent {
  id: string;
  title: string;
  repo: string;
  base: string;
  branch: string;
  harness: Harness;
  model: string;
  effort: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  runs: AgentRun[];
  openQuestions: OpenQuestion[];
  prUrl: string | null;
  parent: AgentParent | null;
  /** The latest tool call or assistant message; null before the first. */
  activity: AgentActivity | null;
}

/** Events the plugin adds to an agent's stream, in the `agent.*` namespace. */
export type PluginEvent =
  | {
      type: 'agent.status';
      status: AgentStatus;
      ts: string;
      /** Why the plugin failed the run, when the runner could not say. */
      error?: string;
    }
  | { type: 'agent.run_started'; runId: string; reason: RunReason; ts: string }
  /** The user's follow-up message, just before the run it starts. */
  | { type: 'agent.message'; text: string; ts: string };

/** The `data` of one `agent-event` SSE message. */
export interface AgentEventEnvelope {
  seq: number;
  runId: string;
  event: RunnerEvent | PluginEvent;
}

export interface ReplyRequest {
  questionId: string;
  answer: string;
}

export interface MessageRequest {
  text: string;
}

/** The credentials a user can store. `github` also has a web flow. */
export type CredentialName = Harness | 'github';

export type CodexCredentialKind = 'api_key' | 'auth_json';

/** Body of `PUT /me/credentials/:name`. `kind` only for codex. */
export interface PutCredentialRequest {
  value: string;
  kind?: CodexCredentialKind;
}

/** `GET /me/credentials`. Values are never returned. */
export interface CredentialsSummary {
  claude: { set: boolean; updatedAt: string | null };
  codex: {
    set: boolean;
    kind: CodexCredentialKind | null;
    updatedAt: string | null;
  };
  opencode: { set: boolean; updatedAt: string | null };
  github: {
    connected: boolean;
    login: string | null;
    method: 'oauth' | 'token' | null;
    updatedAt: string | null;
    /** Whether this Backstage has a GitHub App configured for `/me/github/connect`. */
    connectAvailable: boolean;
  };
}

export interface AccessToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** `POST /me/tokens` response. `token` is shown once. */
export interface CreatedAccessToken {
  id: string;
  token: string;
}

/** A named preset of harness, model, and effort, from `cloudAgents.tiers`. */
export interface TierInfo {
  name: Tier;
  harness: Harness;
  model: string;
  effort: string;
}

/** The tiers used when app-config sets no `cloudAgents.tiers`. */
export const DEFAULT_TIERS: readonly TierInfo[] = [
  {
    name: 'flash',
    harness: 'opencode',
    model: 'opencode-go/deepseek-v4.1-flash',
    effort: 'high',
  },
  { name: 'sol', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  { name: 'opus', harness: 'claude', model: 'claude-opus-5-5', effort: 'high' },
];
