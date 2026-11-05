import type { Knex } from 'knex';
import {
  summarizeToolInput,
  isTerminalAgentStatus,
  type Agent,
  type AgentActivity,
  type AgentChildSummary,
  type AgentKind,
  type AgentParent,
  type AgentRun,
  type AgentStatus,
  type Harness,
  type OpenQuestion,
  type RunnerEvent,
  type RunReason,
  type RunStatus,
} from '@alaborderie/plugin-cloud-agents-common';

export interface AgentRow {
  id: string;
  owner_ref: string;
  kind: AgentKind;
  /** The hub that created this agent. */
  parent_id: string | null;
  /** A hub's plan between runs: the JSON its last `write_state` stored. */
  hub_state: string | null;
  /** The pending stop came from the agent's hub, so it must not wake the hub. */
  stop_by_hub: boolean | number;
  title: string;
  repo: string;
  base: string;
  branch: string;
  harness: Harness;
  model: string;
  effort: string;
  prompt: string;
  status: AgentStatus;
  parent: string | null;
  pr_url: string | null;
  stop_requested: boolean | number;
  last_seq: number;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  agent_id: string;
  ordinal: number;
  reason: RunReason;
  input: string | null;
  status: RunStatus;
  job_name: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  runner_seq: number;
  pr_url: string | null;
  error: string | null;
  /** SHA-256 of the token the run's pod uses to fetch its GitHub token. */
  credential_token_hash: string | null;
}

export interface QuestionRow {
  run_id: string;
  agent_id: string;
  question_id: string;
  question: string;
  options: string;
  blocking: boolean | number;
  answer: string | null;
  answered_at: string | null;
}

export interface EventRow {
  agent_id: string;
  seq: number;
  run_id: string;
  type: string;
  runner_seq: number | null;
  data: string;
}

/** A child event queued for its hub. `run_id` is the hub run that carried it. */
export interface WakeEventRow {
  id?: number;
  hub_id: string;
  child_id: string;
  child_status: AgentStatus;
  created_at: string;
  run_id: string | null;
}

export interface CredentialRow {
  owner_ref: string;
  name: string;
  sealed: string;
  meta: string;
  updated_at: string;
}

export interface AccessTokenRow {
  id: string;
  owner_ref: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
}

export type Db = Knex | Knex.Transaction;

export function nowIso(): string {
  return new Date().toISOString();
}

function toRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
  };
}

function toOpenQuestion(row: QuestionRow): OpenQuestion {
  const options = JSON.parse(row.options) as Array<{ label: string }>;
  return {
    questionId: row.question_id,
    runId: row.run_id,
    question: row.question,
    options: options.map(o => o.label),
  };
}

const ACTIVITY_TYPES = ['tool.call', 'assistant.message'];
const ACTIVITY_TEXT_MAX = 200;

function oneLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > ACTIVITY_TEXT_MAX
    ? `${line.slice(0, ACTIVITY_TEXT_MAX - 1)}…`
    : line;
}

function toActivity(row: Pick<EventRow, 'data'>): AgentActivity | null {
  const event = JSON.parse(row.data) as RunnerEvent;
  if (event.type === 'tool.call') {
    return {
      type: 'tool.call',
      name: event.name,
      kind: event.kind,
      summary: oneLine(summarizeToolInput(event.input)),
      ts: event.ts,
    };
  }
  if (event.type === 'assistant.message') {
    return {
      type: 'assistant.message',
      text: oneLine(event.text),
      ts: event.ts,
    };
  }
  return null;
}

/** SQL for the plugin's tables. Each method is one statement or one read. */
export class Store {
  constructor(readonly knex: Knex) {}

  transaction<T>(fn: (tx: Knex.Transaction) => Promise<T>): Promise<T> {
    return this.knex.transaction(fn);
  }

  async insertAgent(db: Db, row: AgentRow): Promise<void> {
    await db('agents').insert(row);
  }

  async getAgentRow(
    db: Db,
    id: string,
    opts?: { forUpdate?: boolean },
  ): Promise<AgentRow | undefined> {
    const query = db<AgentRow>('agents').where({ id }).first();
    return opts?.forUpdate ? query.forUpdate() : query;
  }

  async updateAgent(
    db: Db,
    id: string,
    patch: Partial<AgentRow>,
  ): Promise<void> {
    await db('agents')
      .where({ id })
      .update({ ...patch, updated_at: nowIso() });
  }

  async listAgentRows(
    owner: string,
    filter: { status?: AgentStatus; parentId?: string; limit?: number },
  ): Promise<AgentRow[]> {
    const query = this.knex<AgentRow>('agents')
      .where({ owner_ref: owner })
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ]);
    if (filter.status) query.andWhere({ status: filter.status });
    if (filter.parentId) query.andWhere({ parent_id: filter.parentId });
    if (filter.limit) query.limit(filter.limit);
    return query;
  }

  /** A hub's children, oldest first. */
  async listChildRows(db: Db, hubId: string): Promise<AgentRow[]> {
    return db<AgentRow>('agents')
      .where({ parent_id: hubId })
      .orderBy([
        { column: 'created_at', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]);
  }

  async insertWakeEvent(db: Db, row: WakeEventRow): Promise<void> {
    await db('wake_events').insert(row);
  }

  async listPendingWakes(db: Db, hubId: string): Promise<WakeEventRow[]> {
    return db<WakeEventRow>('wake_events')
      .where({ hub_id: hubId })
      .whereNull('run_id')
      .orderBy('id', 'asc');
  }

  async assignWakes(db: Db, ids: number[], runId: string): Promise<void> {
    if (ids.length) {
      await db('wake_events').whereIn('id', ids).update({ run_id: runId });
    }
  }

  /** Hubs that sleep with child events still queued, as after a restart. */
  async listWaitingHubsWithWakes(): Promise<string[]> {
    const rows = await this.knex('agents')
      .join('wake_events', 'wake_events.hub_id', 'agents.id')
      .where({ 'agents.status': 'waiting' })
      .whereNull('wake_events.run_id')
      .distinct('agents.id');
    return rows.map(row => String(row.id));
  }

  /** The last `assistant.message` text of the agent's last run. */
  async lastAssistantMessage(
    agentId: string,
    runId: string,
  ): Promise<string | null> {
    const row = await this.knex<EventRow>('events')
      .where({ agent_id: agentId, run_id: runId, type: 'assistant.message' })
      .orderBy('seq', 'desc')
      .first('data');
    if (!row) return null;
    return (JSON.parse(row.data) as { text: string }).text;
  }

  async insertRun(db: Db, row: RunRow): Promise<void> {
    await db('runs').insert(row);
  }

  async getRun(db: Db, id: string): Promise<RunRow | undefined> {
    return db<RunRow>('runs').where({ id }).first();
  }

  async updateRun(db: Db, id: string, patch: Partial<RunRow>): Promise<void> {
    await db('runs').where({ id }).update(patch);
  }

  async listRuns(db: Db, agentId: string): Promise<RunRow[]> {
    return db<RunRow>('runs')
      .where({ agent_id: agentId })
      .orderBy('ordinal', 'asc');
  }

  async listActiveRuns(): Promise<RunRow[]> {
    return this.knex<RunRow>('runs').where({ status: 'running' });
  }

  async findActiveRunAgent(
    credentialTokenHash: string,
  ): Promise<AgentRow | undefined> {
    return this.knex<AgentRow>('agents')
      .join('runs', 'runs.agent_id', 'agents.id')
      .where({
        'runs.credential_token_hash': credentialTokenHash,
        'runs.status': 'running',
      })
      .first('agents.*');
  }

  async insertQuestion(db: Db, row: QuestionRow): Promise<void> {
    await db('questions')
      .insert(row)
      .onConflict(['run_id', 'question_id'])
      .ignore();
  }

  async listQuestions(db: Db, runId: string): Promise<QuestionRow[]> {
    return db<QuestionRow>('questions').where({ run_id: runId });
  }

  async answerQuestion(
    db: Db,
    runId: string,
    questionId: string,
    answer: string,
  ): Promise<void> {
    await db('questions')
      .where({ run_id: runId, question_id: questionId })
      .update({ answer, answered_at: nowIso() });
  }

  async insertEvent(db: Db, row: EventRow): Promise<void> {
    await db('events').insert(row);
  }

  async hasRunnerEvent(
    db: Db,
    runId: string,
    runnerSeq: number,
  ): Promise<boolean> {
    const row = await db('events')
      .where({ run_id: runId, runner_seq: runnerSeq })
      .first('seq');
    return row !== undefined;
  }

  async listEventsAfter(
    agentId: string,
    after: number,
    limit: number,
  ): Promise<EventRow[]> {
    return this.knex<EventRow>('events')
      .where({ agent_id: agentId })
      .andWhere('seq', '>', after)
      .orderBy('seq', 'asc')
      .limit(limit);
  }

  /** The agent's latest tool call or assistant message. */
  async lastActivity(agentId: string): Promise<AgentActivity | null> {
    const row = await this.knex<EventRow>('events')
      .where({ agent_id: agentId })
      .whereIn('type', ACTIVITY_TYPES)
      .orderBy('seq', 'desc')
      .first('data');
    return row ? toActivity(row) : null;
  }

  /** The blocking questions of the agent's last run that have no answer. */
  async openQuestions(db: Db, agentId: string): Promise<QuestionRow[]> {
    const runs = await this.listRuns(db, agentId);
    const lastRun = runs[runs.length - 1];
    if (!lastRun) return [];
    const questions = await this.listQuestions(db, lastRun.id);
    return questions.filter(q => Boolean(q.blocking) && q.answer === null);
  }

  private async childSummaries(hubId: string): Promise<AgentChildSummary[]> {
    const rows = await this.listChildRows(this.knex, hubId);
    return Promise.all(
      rows.map(async child => ({
        id: child.id,
        title: child.title,
        status: child.status,
        branch: child.branch,
        prUrl: child.pr_url,
        openQuestions: (await this.openQuestions(this.knex, child.id)).length,
        updatedAt: child.updated_at,
      })),
    );
  }

  /** Whether any child of the hub can still change. */
  async hasActiveChild(db: Db, hubId: string): Promise<boolean> {
    const rows = await this.listChildRows(db, hubId);
    return rows.some(child => !isTerminalAgentStatus(child.status));
  }

  /** The agent object of docs/API.md, with its runs and open questions. */
  async toAgent(row: AgentRow): Promise<Agent> {
    const runs = await this.listRuns(this.knex, row.id);
    const lastRun = runs[runs.length - 1];
    const questions = lastRun
      ? await this.listQuestions(this.knex, lastRun.id)
      : [];
    const activity = await this.lastActivity(row.id);
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      repo: row.repo,
      base: row.base,
      branch: row.branch,
      harness: row.harness,
      model: row.model,
      effort: row.effort,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      runs: runs.map(toRun),
      openQuestions: questions
        .filter(q => Boolean(q.blocking) && q.answer === null)
        .map(toOpenQuestion),
      prUrl: row.pr_url,
      parent: row.parent ? (JSON.parse(row.parent) as AgentParent) : null,
      parentId: row.parent_id,
      children: row.kind === 'hub' ? await this.childSummaries(row.id) : [],
      activity,
    };
  }

  async getCredential(
    owner: string,
    name: string,
    db: Db = this.knex,
    opts?: { forUpdate?: boolean },
  ): Promise<CredentialRow | undefined> {
    const query = db<CredentialRow>('credentials')
      .where({ owner_ref: owner, name })
      .first();
    return opts?.forUpdate ? query.forUpdate() : query;
  }

  async listCredentials(owner: string): Promise<CredentialRow[]> {
    return this.knex<CredentialRow>('credentials').where({ owner_ref: owner });
  }

  async putCredential(row: CredentialRow, db: Db = this.knex): Promise<void> {
    await db('credentials')
      .insert(row)
      .onConflict(['owner_ref', 'name'])
      .merge(['sealed', 'meta', 'updated_at']);
  }

  async deleteCredential(owner: string, name: string): Promise<void> {
    await this.knex('credentials').where({ owner_ref: owner, name }).delete();
  }

  async insertAccessToken(row: AccessTokenRow): Promise<void> {
    await this.knex('access_tokens').insert(row);
  }

  async listAccessTokens(owner: string): Promise<AccessTokenRow[]> {
    return this.knex<AccessTokenRow>('access_tokens')
      .where({ owner_ref: owner })
      .orderBy('created_at', 'desc');
  }

  async deleteAccessToken(owner: string, id: string): Promise<number> {
    return this.knex('access_tokens').where({ owner_ref: owner, id }).delete();
  }

  async findAccessToken(hash: string): Promise<AccessTokenRow | undefined> {
    return this.knex<AccessTokenRow>('access_tokens')
      .where({ token_hash: hash })
      .first();
  }

  async touchAccessToken(id: string): Promise<void> {
    await this.knex('access_tokens')
      .where({ id })
      .update({ last_used_at: nowIso() });
  }

  async insertOauthState(stateHash: string, owner: string): Promise<void> {
    await this.knex('github_oauth_states').insert({
      state_hash: stateHash,
      owner_ref: owner,
      created_at: nowIso(),
    });
  }

  /** Deletes and returns the state, so a callback can use it only once. */
  async takeOauthState(
    stateHash: string,
    notBefore: string,
  ): Promise<string | undefined> {
    return this.transaction(async tx => {
      const row = await tx('github_oauth_states')
        .where({ state_hash: stateHash })
        .first();
      await tx('github_oauth_states')
        .where({ state_hash: stateHash })
        .orWhere('created_at', '<', notBefore)
        .delete();
      if (!row || row.created_at < notBefore) return undefined;
      return row.owner_ref as string;
    });
  }
}
