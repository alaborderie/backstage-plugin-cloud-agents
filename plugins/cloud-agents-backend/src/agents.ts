import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { ConflictError, InputError, NotFoundError } from '@backstage/errors';
import {
  isTerminalAgentStatus,
  type Agent,
  type AgentStatus,
  type CreateAgentRequest,
  type Harness,
  type PluginEvent,
  type RunnerEvent,
  type RunnerFinishStatus,
  type RunReason,
  type RunStatus,
  type TierInfo,
} from '@alaborderie/plugin-cloud-agents-common';
import type { CredentialService, RunCredentials } from './credentials';
import { randomToken, sha256Hex } from './crypto';
import { jobNameFor, RUN_TOKEN_ENV } from './jobSpec';
import { KubernetesRefusal, type Cluster } from './kube';
import { messageSection, replySection, runPrompt } from './prompt';
import {
  nowIso,
  type AgentRow,
  type EventRow,
  type RunRow,
  type Store,
} from './store';

/** How a run ended, from its `run.finished` event or from what Kubernetes saw. */
export interface RunOutcome {
  status: RunStatus;
  exitCode: number | null;
  prUrl: string | null;
  error: string | null;
}

const RUN_STATUS_OF_FINISH: Record<RunnerFinishStatus, RunStatus> = {
  succeeded: 'succeeded',
  failed: 'failed',
  needs_input: 'needs_input',
  cancelled: 'stopped',
};

/** The runner's exit codes (runner/README.md), for a pod that printed no `run.finished`. */
export function outcomeOfExitCode(
  exitCode: number,
  stopRequested: boolean,
): RunOutcome {
  const byCode: Record<number, RunStatus> = {
    0: 'succeeded',
    3: 'needs_input',
  };
  const status: RunStatus =
    stopRequested || exitCode === 130 || exitCode === 143
      ? 'stopped'
      : byCode[exitCode] ?? 'failed';
  return {
    status,
    exitCode,
    prUrl: null,
    error:
      status === 'failed'
        ? `The runner exited with code ${exitCode} without reporting run.finished`
        : null,
  };
}

interface Mutation {
  tx: Knex.Transaction;
  agent: AgentRow;
  append(
    runId: string,
    event: PluginEvent | { raw: string; type: string; runnerSeq: number },
  ): Promise<void>;
  setStatus(runId: string, status: AgentStatus, error?: string): Promise<void>;
}

export interface StreamHandle {
  close(): void;
}

const REPLAY_PAGE = 500;

/** Rolls back a reply that would start a run before its credentials loaded. */
class CredentialsNeeded extends Error {}

function isTerminalStatusEvent(row: EventRow): boolean {
  return (
    row.type === 'agent.status' &&
    isTerminalAgentStatus(
      (JSON.parse(row.data) as { status: AgentStatus }).status,
    )
  );
}

/**
 * One SSE subscriber. Live events that arrive during the replay wait in a
 * queue, and `last` drops anything already sent, so the client sees each seq
 * once and in order.
 */
class AgentStream implements StreamHandle {
  private replaying = true;
  private closed = false;
  private readonly queued: EventRow[] = [];
  private readonly onLive = (row: EventRow) => {
    if (this.replaying) {
      this.queued.push(row);
      return;
    }
    this.deliver(row);
    if (isTerminalStatusEvent(row)) this.close();
  };

  constructor(
    private readonly store: Store,
    private readonly emitter: EventEmitter,
    private readonly agentId: string,
    private last: number,
    private readonly send: (row: EventRow) => void,
    private readonly end: () => void,
  ) {}

  async start(): Promise<void> {
    this.emitter.on(this.agentId, this.onLive);
    try {
      await this.replay();
      this.replaying = false;
      this.queued.splice(0).forEach(row => this.deliver(row));
      const agent = await this.store.getAgentRow(this.store.knex, this.agentId);
      if (agent && isTerminalAgentStatus(agent.status)) {
        await this.replay();
        this.close();
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emitter.off(this.agentId, this.onLive);
    this.end();
  }

  private deliver(row: EventRow): void {
    if (this.closed || row.seq <= this.last) return;
    this.last = row.seq;
    this.send(row);
  }

  private async replay(): Promise<void> {
    for (;;) {
      const rows = await this.store.listEventsAfter(
        this.agentId,
        this.last,
        REPLAY_PAGE,
      );
      rows.forEach(row => this.deliver(row));
      if (rows.length < REPLAY_PAGE) return;
    }
  }
}

/**
 * The agent lifecycle: creating agents, starting and finishing runs, storing
 * events, and fanning them out. Every change to an agent runs in one
 * transaction that locks the agent row, so event seqs have no gaps or
 * duplicates.
 */
export class AgentService {
  private readonly emitter = new EventEmitter();

  /** Set by the follower registry so a new run starts being followed. */
  onRunStarted: (run: RunRow) => void = () => {};

  constructor(
    private readonly store: Store,
    private readonly cluster: Cluster,
    private readonly credentials: CredentialService,
    private readonly tiers: Map<string, TierInfo>,
    private readonly logger: LoggerService,
  ) {
    this.emitter.setMaxListeners(0);
  }

  private async mutate<T>(
    agentId: string,
    fn: (m: Mutation) => Promise<T>,
  ): Promise<T> {
    const published: EventRow[] = [];
    const result = await this.store.transaction(async tx => {
      const agent = await this.store.getAgentRow(tx, agentId, {
        forUpdate: true,
      });
      if (!agent) throw new NotFoundError(`No agent ${agentId}`);
      const m: Mutation = {
        tx,
        agent,
        append: async (runId, event) => {
          const seq = agent.last_seq + 1;
          const row: EventRow =
            'raw' in event
              ? {
                  agent_id: agentId,
                  seq,
                  run_id: runId,
                  type: event.type,
                  runner_seq: event.runnerSeq,
                  data: event.raw,
                }
              : {
                  agent_id: agentId,
                  seq,
                  run_id: runId,
                  type: event.type,
                  runner_seq: null,
                  data: JSON.stringify(event),
                };
          await this.store.insertEvent(tx, row);
          agent.last_seq = seq;
          await this.store.updateAgent(tx, agentId, { last_seq: seq });
          published.push(row);
        },
        setStatus: async (runId, status, error) => {
          if (agent.status === status) return;
          agent.status = status;
          await this.store.updateAgent(tx, agentId, { status });
          await m.append(runId, {
            type: 'agent.status',
            status,
            ts: nowIso(),
            ...(error ? { error } : {}),
          });
        },
      };
      return fn(m);
    });
    for (const row of published) this.emitter.emit(agentId, row);
    return result;
  }

  private async ownedAgentRow(owner: string, id: string): Promise<AgentRow> {
    const row = await this.store.getAgentRow(this.store.knex, id);
    if (!row || row.owner_ref !== owner) {
      throw new NotFoundError(`No agent ${id}`);
    }
    return row;
  }

  async getAgent(owner: string, id: string): Promise<Agent> {
    return this.store.toAgent(await this.ownedAgentRow(owner, id));
  }

  async listAgents(
    owner: string,
    status: AgentStatus | undefined,
  ): Promise<Agent[]> {
    const rows = await this.store.listAgentRows(owner, status);
    return Promise.all(rows.map(row => this.store.toAgent(row)));
  }

  private resolveHarness(req: CreateAgentRequest): {
    harness: Harness;
    model: string;
    effort: string;
  } {
    if (req.tier !== undefined) {
      if (req.harness !== undefined || req.model !== undefined) {
        throw new InputError('Give tier, or harness and model, not both');
      }
      const tier = this.tiers.get(req.tier);
      if (!tier) {
        throw new InputError(
          `Unknown tier '${req.tier}'. Known tiers: ${[
            ...this.tiers.keys(),
          ].join(', ')}`,
        );
      }
      return { harness: tier.harness, model: tier.model, effort: tier.effort };
    }
    if (req.harness === undefined || req.model === undefined) {
      throw new InputError('Give tier, or harness and model');
    }
    return {
      harness: req.harness,
      model: req.model,
      effort: req.effort ?? 'high',
    };
  }

  async createAgent(owner: string, req: CreateAgentRequest): Promise<Agent> {
    const { harness, model, effort } = this.resolveHarness(req);
    const credentials = await this.credentials.forRun(owner, harness);
    const shortId = randomBytes(6).toString('hex');
    const id = `ag_${shortId}`;
    const now = nowIso();
    const title =
      req.title?.trim() ||
      (req.prompt.trim().split('\n')[0] ?? '').slice(0, 80) ||
      id;
    const row: AgentRow = {
      id,
      owner_ref: owner,
      title,
      repo: req.repo,
      base: req.base ?? 'main',
      branch: req.branch ?? `cloud-agent/${shortId}`,
      harness,
      model,
      effort,
      prompt: req.prompt,
      status: 'queued',
      parent: req.parent ? JSON.stringify(req.parent) : null,
      pr_url: null,
      stop_requested: false,
      last_seq: 0,
      created_at: now,
      updated_at: now,
    };
    await this.store.insertAgent(this.store.knex, row);
    await this.startRun(row.id, 'initial', credentials, async () => null);
    return this.getAgent(owner, id);
  }

  /**
   * Records the run, then creates its Job. A failed launch fails the run.
   * `decide` runs under the agent row lock: it checks that the run may start
   * and returns the run's prompt input, or `false` to start no run.
   */
  private async startRun(
    agentId: string,
    reason: RunReason,
    credentials: RunCredentials | undefined,
    decide: (
      m: Mutation,
      lastRun: RunRow | undefined,
    ) => Promise<string | null | false>,
    followUp?: string,
  ): Promise<void> {
    const runToken = randomToken(32);
    const started = await this.mutate(agentId, async m => {
      const runs = await this.store.listRuns(m.tx, agentId);
      const input = await decide(m, runs[runs.length - 1]);
      if (input === false) return undefined;
      const ordinal = runs.length + 1;
      const runRow: RunRow = {
        id: randomUUID(),
        agent_id: agentId,
        ordinal,
        reason,
        input,
        status: 'running',
        job_name: jobNameFor(agentId, ordinal),
        started_at: nowIso(),
        finished_at: null,
        exit_code: null,
        runner_seq: -1,
        pr_url: null,
        error: null,
        credential_token_hash: sha256Hex(runToken),
      };
      await this.store.insertRun(m.tx, runRow);
      await this.store.updateAgent(m.tx, agentId, { stop_requested: false });
      if (followUp !== undefined) {
        await m.append(runRow.id, {
          type: 'agent.message',
          text: followUp,
          ts: nowIso(),
        });
      }
      await m.append(runRow.id, {
        type: 'agent.run_started',
        runId: runRow.id,
        reason,
        ts: nowIso(),
      });
      await m.setStatus(runRow.id, 'queued');
      const inputs = [...runs.map(r => r.input), input].filter(
        (i): i is string => i !== null,
      );
      return {
        run: runRow,
        agent: m.agent,
        prompt: runPrompt(m.agent.prompt, inputs),
      };
    });
    if (!started) return;
    const { run, agent, prompt } = started;
    if (!credentials) throw new Error(`No credentials to start run ${run.id}`);

    try {
      await this.cluster.launch({
        agentId,
        runId: run.id,
        jobName: run.job_name,
        harness: agent.harness,
        model: agent.model,
        effort: agent.effort,
        repo: agent.repo,
        base: agent.base,
        branch: agent.branch,
        prompt,
        credentials: {
          ...credentials,
          env: { ...credentials.env, [RUN_TOKEN_ENV]: runToken },
        },
      });
    } catch (error) {
      const message = `Could not create the Job: ${(error as Error).message}`;
      this.logger.error(`Agent ${agentId} run ${run.id}: ${message}`);
      await this.cluster.deleteJob(run.job_name).catch(() => {});
      await this.finishRun(run.id, {
        status: 'failed',
        exitCode: null,
        prUrl: null,
        error: message,
      });
      return;
    }
    this.onRunStarted(run);
  }

  /**
   * Stores one runner event unless it is already stored, and applies what it
   * means for the run and the agent. Returns whether the run is over.
   */
  async ingest(run: RunRow, event: RunnerEvent, raw: string): Promise<boolean> {
    return this.mutate(run.agent_id, async m => {
      const current = await this.store.getRun(m.tx, run.id);
      if (!current || current.status !== 'running') return true;
      if (await this.store.hasRunnerEvent(m.tx, run.id, event.seq)) {
        return false;
      }
      await m.append(run.id, { raw, type: event.type, runnerSeq: event.seq });
      await this.store.updateRun(m.tx, run.id, { runner_seq: event.seq });

      if (event.type === 'run.started' && m.agent.status === 'queued') {
        await m.setStatus(run.id, 'running');
      }
      if (event.type === 'question') {
        await this.store.insertQuestion(m.tx, {
          run_id: run.id,
          agent_id: run.agent_id,
          question_id: event.question_id,
          question: event.question,
          options: JSON.stringify(event.options),
          blocking: event.blocking,
          answer: null,
          answered_at: null,
        });
      }
      if (event.type === 'run.finished') {
        await this.applyOutcome(m, run.id, {
          status: RUN_STATUS_OF_FINISH[event.status],
          exitCode: event.exit_code,
          prUrl: event.pr_url,
          error: event.error,
        });
        return true;
      }
      return false;
    });
  }

  async finishRun(runId: string, outcome: RunOutcome): Promise<void> {
    const run = await this.store.getRun(this.store.knex, runId);
    if (!run) return;
    await this.mutate(run.agent_id, async m => {
      const current = await this.store.getRun(m.tx, runId);
      if (current?.status !== 'running') return;
      await this.applyOutcome(m, runId, outcome);
    });
  }

  private async applyOutcome(
    m: Mutation,
    runId: string,
    outcome: RunOutcome,
  ): Promise<void> {
    await this.store.updateRun(m.tx, runId, {
      status: outcome.status,
      exit_code: outcome.exitCode,
      finished_at: nowIso(),
      pr_url: outcome.prUrl,
      error: outcome.error,
    });
    if (outcome.prUrl) {
      await this.store.updateAgent(m.tx, m.agent.id, { pr_url: outcome.prUrl });
    }
    await m.setStatus(
      runId,
      outcome.status === 'running' ? 'running' : outcome.status,
      outcome.status === 'failed' ? outcome.error ?? undefined : undefined,
    );
  }

  async isStopRequested(agentId: string): Promise<boolean> {
    const row = await this.store.getAgentRow(this.store.knex, agentId);
    return Boolean(row?.stop_requested);
  }

  private async lastRun(agentId: string): Promise<RunRow | undefined> {
    const runs = await this.store.listRuns(this.store.knex, agentId);
    return runs[runs.length - 1];
  }

  async reply(
    owner: string,
    id: string,
    questionId: string,
    answer: string,
  ): Promise<void> {
    const agent = await this.ownedAgentRow(owner, id);
    // Only the answer that completes the set starts a run and needs the
    // credentials. When the locked check finds that this answer completes it,
    // the transaction rolls back, the credentials load, and the reply retries.
    try {
      await this.replyOnce(id, questionId, answer, undefined);
    } catch (error) {
      if (!(error instanceof CredentialsNeeded)) throw error;
      const credentials = await this.credentials.forRun(owner, agent.harness);
      await this.replyOnce(id, questionId, answer, credentials);
    }
  }

  private async replyOnce(
    id: string,
    questionId: string,
    answer: string,
    credentials: RunCredentials | undefined,
  ): Promise<void> {
    await this.startRun(id, 'reply', credentials, async (m, run) => {
      if (m.agent.status !== 'needs_input' || !run) {
        throw new ConflictError(
          `Agent ${id} is ${m.agent.status}, not needs_input`,
        );
      }
      const questions = (await this.store.listQuestions(m.tx, run.id)).filter(
        q => Boolean(q.blocking),
      );
      const question = questions.find(q => q.question_id === questionId);
      if (!question) {
        throw new NotFoundError(
          `No open question ${questionId} on agent ${id}`,
        );
      }
      if (question.answer !== null) {
        throw new ConflictError(`Question ${questionId} already has an answer`);
      }
      const answered = questions.map(q =>
        q.question_id === questionId ? { ...q, answer } : q,
      );
      const complete = answered.every(q => q.answer !== null);
      if (complete && !credentials) throw new CredentialsNeeded();
      await this.store.answerQuestion(m.tx, run.id, questionId, answer);
      if (!complete) return false;
      return replySection(
        m.agent.branch,
        answered.map(q => ({
          question: q.question,
          answer: q.answer ?? '',
        })),
      );
    });
  }

  async message(owner: string, id: string, text: string): Promise<void> {
    const agent = await this.ownedAgentRow(owner, id);
    const busy = (status: AgentStatus) =>
      status === 'queued' || status === 'running';
    if (busy(agent.status)) {
      throw new ConflictError(`Agent ${id} has an active run`);
    }
    const credentials = await this.credentials.forRun(owner, agent.harness);
    await this.startRun(
      id,
      'message',
      credentials,
      async m => {
        if (busy(m.agent.status)) {
          throw new ConflictError(`Agent ${id} has an active run`);
        }
        return messageSection(m.agent.branch, text);
      },
      text,
    );
  }

  /**
   * Deletes the active Job. The follower then sees `run.finished` with
   * `cancelled` (or the pod disappear) and sets the agent to `stopped`.
   */
  async stop(owner: string, id: string): Promise<void> {
    const agent = await this.ownedAgentRow(owner, id);
    if (isTerminalAgentStatus(agent.status)) return;
    const run = await this.lastRun(id);
    if (run?.status === 'running') {
      await this.store.updateAgent(this.store.knex, id, {
        stop_requested: true,
      });
      try {
        await this.cluster.deleteJob(run.job_name);
      } catch (error) {
        if (!(error instanceof KubernetesRefusal)) throw error;
        await this.finishRun(run.id, {
          status: 'failed',
          exitCode: null,
          prUrl: null,
          error: error.message,
        });
      }
      return;
    }
    await this.mutate(id, async m => {
      if (!isTerminalAgentStatus(m.agent.status)) {
        await m.setStatus(run?.id ?? '', 'stopped');
      }
    });
  }

  /**
   * Sends the stored events after `after`, then live ones, in seq order. Ends
   * once the agent is terminal and every event up to that point was sent.
   */
  async openStream(
    owner: string,
    id: string,
    after: number,
    send: (row: EventRow) => void,
    end: () => void,
  ): Promise<StreamHandle> {
    await this.ownedAgentRow(owner, id);
    const stream = new AgentStream(
      this.store,
      this.emitter,
      id,
      after,
      send,
      end,
    );
    await stream.start();
    return stream;
  }
}
