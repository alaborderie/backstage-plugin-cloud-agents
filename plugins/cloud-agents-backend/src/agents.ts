import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { LoggerService } from '@backstage/backend-plugin-api';
import {
  ConflictError,
  InputError,
  NotAllowedError,
  NotFoundError,
} from '@backstage/errors';
import {
  isTerminalAgentStatus,
  type Agent,
  type AgentKind,
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
import {
  MissingCredentialError,
  type CredentialService,
  type RunCredentials,
} from './credentials';
import { randomToken, sha256Hex } from './crypto';
import { jobNameFor, RUN_TOKEN_ENV } from './jobSpec';
import { KubernetesRefusal, type Cluster } from './kube';
import {
  hubRunPrompt,
  hubSections,
  messageSection,
  replySection,
  runPrompt,
  type WakeLine,
} from './prompt';
import { HUB_RUN_SUBJECT_PREFIX, signHubRunToken } from './runTokens';
import {
  nowIso,
  type AgentRow,
  type EventRow,
  type RunRow,
  type Store,
} from './store';

/**
 * Who acts on agents: a user on all of their agents, or an active hub run on
 * that hub's children only.
 */
export type Actor =
  | { type: 'user'; owner: string }
  | { type: 'hub'; owner: string; hubId: string; runId: string };

/** What a run adds to its agent's prompt: a follow-up message or the answers. */
interface RunInput {
  message?: string;
  answers?: Array<{ questionId: string; question: string; answer: string }>;
}

/** A child in one of these statuses wakes its hub. */
const WAKE_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'needs_input',
  'succeeded',
  'failed',
  'stopped',
]);

const LAST_MESSAGE_MAX = 8000;
/** A hub run token stays valid this long after the Job's deadline. */
const RUN_TOKEN_GRACE_MS = 10 * 60 * 1000;

export interface AgentServiceOptions {
  /** HMAC key of hub run tokens. */
  runTokenKey: Buffer;
  /** Hubs need the runner API URL; without it the plugin refuses to create one. */
  hubsAvailable: boolean;
  activeDeadlineSeconds: number;
  hubWakeDelayMs: number;
}

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
  /** Starts a run of this hub after the commit, after `delayMs`. */
  wakeHub(hubId: string, delayMs: number): void;
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
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();

  /** Set by the follower registry so a new run starts being followed. */
  onRunStarted: (run: RunRow) => void = () => {};

  constructor(
    private readonly store: Store,
    private readonly cluster: Cluster,
    private readonly credentials: CredentialService,
    private readonly tiers: Map<string, TierInfo>,
    private readonly logger: LoggerService,
    private readonly options: AgentServiceOptions,
  ) {
    this.emitter.setMaxListeners(0);
  }

  private async mutate<T>(
    agentId: string,
    fn: (m: Mutation) => Promise<T>,
  ): Promise<T> {
    const published: EventRow[] = [];
    const wakes = new Map<string, number>();
    const result = await this.store.transaction(async tx => {
      published.length = 0;
      wakes.clear();
      const agent = await this.store.getAgentRow(tx, agentId, {
        forUpdate: true,
      });
      if (!agent) throw new NotFoundError(`No agent ${agentId}`);
      const m: Mutation = {
        tx,
        agent,
        wakeHub: (hubId, delayMs) => {
          wakes.set(hubId, Math.min(delayMs, wakes.get(hubId) ?? delayMs));
        },
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
          const hubId = agent.parent_id;
          if (
            hubId &&
            WAKE_STATUSES.has(status) &&
            !(status === 'stopped' && agent.stop_by_hub)
          ) {
            await this.store.insertWakeEvent(tx, {
              hub_id: hubId,
              child_id: agent.id,
              child_status: status,
              created_at: nowIso(),
              run_id: null,
            });
            m.wakeHub(hubId, this.options.hubWakeDelayMs);
          }
        },
      };
      return fn(m);
    });
    for (const row of published) this.emitter.emit(agentId, row);
    for (const [hubId, delayMs] of wakes) this.scheduleWake(hubId, delayMs);
    return result;
  }

  /**
   * Starts a run of the hub once `delayMs` passed, so events of several
   * children that finish close together go to one run. The run starts only
   * if the hub is still `waiting` with events queued; otherwise the next run
   * carries them.
   */
  private scheduleWake(hubId: string, delayMs: number): void {
    const pending = this.wakeTimers.get(hubId);
    if (pending && delayMs > 0) return;
    clearTimeout(pending);
    const timer = setTimeout(() => {
      this.wakeTimers.delete(hubId);
      this.wakeHub(hubId).catch(error =>
        this.logger.error(
          `Could not wake hub ${hubId}: ${(error as Error).message}`,
        ),
      );
    }, delayMs);
    this.wakeTimers.set(hubId, timer);
  }

  private async wakeHub(hubId: string): Promise<void> {
    const hub = await this.store.getAgentRow(this.store.knex, hubId);
    if (hub?.status !== 'waiting') return;
    let credentials: RunCredentials;
    try {
      credentials = await this.credentials.forRun(hub.owner_ref, hub.harness);
    } catch (error) {
      if (!(error instanceof MissingCredentialError)) throw error;
      await this.mutate(hubId, async m => {
        if (m.agent.status === 'waiting') {
          await m.setStatus(
            '',
            'failed',
            `Could not wake the hub: ${error.message}`,
          );
        }
      });
      return;
    }
    await this.startRun(hubId, 'child', credentials, async m =>
      m.agent.status === 'waiting' &&
      (await this.store.listPendingWakes(m.tx, hubId)).length > 0
        ? {}
        : false,
    );
  }

  /** Wakes every hub that sleeps with child events queued, as after a restart. */
  async resumeHubs(): Promise<void> {
    for (const hubId of await this.store.listWaitingHubsWithWakes()) {
      this.scheduleWake(hubId, 0);
    }
  }

  stopWakes(): void {
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
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
    filter: { status?: AgentStatus; parentId?: string; limit?: number },
  ): Promise<Agent[]> {
    const rows = await this.store.listAgentRows(owner, filter);
    return Promise.all(rows.map(row => this.store.toAgent(row)));
  }

  /** The agent and the last `assistant.message` text of its last run. */
  async getAgentWithLastMessage(
    owner: string,
    id: string,
  ): Promise<{ agent: Agent; lastMessage: string | null }> {
    const row = await this.ownedAgentRow(owner, id);
    const run = await this.lastRun(id);
    const text = run ? await this.store.lastAssistantMessage(id, run.id) : null;
    return {
      agent: await this.store.toAgent(row),
      lastMessage: text === null ? null : text.slice(0, LAST_MESSAGE_MAX),
    };
  }

  /**
   * The actor of a hub run's service principal: the run must be active and
   * belong to a hub.
   */
  async hubRunActor(subject: string): Promise<Actor> {
    const runId = subject.slice(HUB_RUN_SUBJECT_PREFIX.length);
    const run = subject.startsWith(HUB_RUN_SUBJECT_PREFIX)
      ? await this.store.getRun(this.store.knex, runId)
      : undefined;
    const hub =
      run?.status === 'running'
        ? await this.store.getAgentRow(this.store.knex, run.agent_id)
        : undefined;
    if (!run || hub?.kind !== 'hub') {
      throw new NotAllowedError('This run is not an active hub run');
    }
    return { type: 'hub', owner: hub.owner_ref, hubId: hub.id, runId };
  }

  /** Refuses an agent that is not a child of the acting hub. */
  async assertReachable(actor: Actor, id: string): Promise<void> {
    if (actor.type === 'user') {
      await this.ownedAgentRow(actor.owner, id);
      return;
    }
    const row = await this.store.getAgentRow(this.store.knex, id);
    if (row?.parent_id !== actor.hubId || row.owner_ref !== actor.owner) {
      throw new NotAllowedError('not_your_child');
    }
  }

  async hubState(hubId: string): Promise<unknown> {
    const row = await this.store.getAgentRow(this.store.knex, hubId);
    return row?.hub_state ? (JSON.parse(row.hub_state) as unknown) : null;
  }

  async setHubState(hubId: string, state: unknown): Promise<void> {
    await this.store.updateAgent(this.store.knex, hubId, {
      hub_state: JSON.stringify(state),
    });
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

  async createAgent(
    owner: string,
    req: CreateAgentRequest,
    parentId: string | null = null,
  ): Promise<Agent> {
    const kind: AgentKind = req.kind ?? 'task';
    if (kind === 'hub' && !this.options.hubsAvailable) {
      throw new InputError(
        'Hubs need cloudAgents.runnerBackendUrl, which this Backstage does not set',
      );
    }
    if (kind === 'hub' && parentId) {
      throw new InputError('A hub creates tasks, not hubs');
    }
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
      kind,
      parent_id: parentId,
      hub_state: null,
      stop_by_hub: false,
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
    await this.startRun(row.id, 'initial', credentials, async () => ({}));
    return this.getAgent(owner, id);
  }

  /**
   * Records the run, then creates its Job. A failed launch fails the run.
   * `decide` runs under the agent row lock: it checks that the run may start
   * and returns what the run adds to the prompt, or `false` to start no run.
   * A hub run also carries every child event queued for the hub.
   */
  private async startRun(
    agentId: string,
    reason: RunReason,
    credentials: RunCredentials | undefined,
    decide: (
      m: Mutation,
      lastRun: RunRow | undefined,
    ) => Promise<RunInput | false>,
  ): Promise<void> {
    const started = await this.mutate(agentId, async m => {
      const runs = await this.store.listRuns(m.tx, agentId);
      const decided = await decide(m, runs[runs.length - 1]);
      if (decided === false) return undefined;
      const ordinal = runs.length + 1;
      const runId = randomUUID();
      const runToken =
        m.agent.kind === 'hub'
          ? signHubRunToken(
              this.options.runTokenKey,
              runId,
              new Date(
                Date.now() +
                  this.options.activeDeadlineSeconds * 1000 +
                  RUN_TOKEN_GRACE_MS,
              ),
            )
          : randomToken(32);
      const wakes =
        m.agent.kind === 'hub'
          ? await this.store.listPendingWakes(m.tx, agentId)
          : [];
      const input =
        m.agent.kind === 'hub'
          ? hubSections({
              wakes: await Promise.all(
                wakes.map(w => this.wakeLine(m.tx, w.child_id, w.child_status)),
              ),
              messages: decided.message ? [decided.message] : [],
              answers: decided.answers ?? [],
            })
          : this.taskSection(m.agent.branch, decided);
      const runRow: RunRow = {
        id: runId,
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
      await this.store.assignWakes(
        m.tx,
        wakes.map(w => w.id as number),
        runId,
      );
      await this.store.updateAgent(m.tx, agentId, {
        stop_requested: false,
        stop_by_hub: false,
      });
      m.agent.stop_by_hub = false;
      for (const wake of wakes) {
        await m.append(runId, {
          type: 'agent.wake',
          childId: wake.child_id,
          childStatus: wake.child_status,
          ts: nowIso(),
        });
      }
      if (decided.message !== undefined) {
        await m.append(runId, {
          type: 'agent.message',
          text: decided.message,
          ts: nowIso(),
        });
      }
      await m.append(runId, {
        type: 'agent.run_started',
        runId,
        reason,
        ts: nowIso(),
      });
      await m.setStatus(runId, 'queued');
      const prompt =
        m.agent.kind === 'hub'
          ? hubRunPrompt(m.agent.prompt, input)
          : runPrompt(
              m.agent.prompt,
              [...runs.map(r => r.input), input].filter(
                (i): i is string => i !== null,
              ),
            );
      return { run: runRow, agent: m.agent, prompt, runToken };
    });
    if (!started) return;
    const { run, agent, prompt, runToken } = started;
    if (!credentials) throw new Error(`No credentials to start run ${run.id}`);

    try {
      await this.cluster.launch({
        agentId,
        kind: agent.kind,
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

  private taskSection(branch: string, input: RunInput): string | null {
    if (input.message !== undefined)
      return messageSection(branch, input.message);
    if (input.answers) return replySection(branch, input.answers);
    return null;
  }

  private async wakeLine(
    tx: Knex.Transaction,
    childId: string,
    status: AgentStatus,
  ): Promise<WakeLine> {
    const child = await this.store.getAgentRow(tx, childId);
    const questions =
      status === 'needs_input'
        ? await this.store.openQuestions(tx, childId)
        : [];
    return {
      childId,
      title: child?.title ?? childId,
      status,
      branch: child?.branch ?? '',
      prUrl: child?.pr_url ?? null,
      questions: questions.map(q => ({
        questionId: q.question_id,
        question: q.question,
        options: (JSON.parse(q.options) as Array<{ label: string }>).map(
          o => o.label,
        ),
      })),
    };
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
    const status =
      m.agent.kind === 'hub'
        ? await this.hubStatusAfterRun(m, outcome.status)
        : outcome.status;
    await m.setStatus(
      runId,
      status,
      status === 'failed' ? outcome.error ?? undefined : undefined,
    );
  }

  /**
   * docs/API.md "Hub lifecycle": a hub's own question or stop wins, then
   * queued child events start the next run at once, then a child that is
   * still working puts the hub to sleep. Only then does the run decide.
   */
  private async hubStatusAfterRun(
    m: Mutation,
    runStatus: RunStatus,
  ): Promise<AgentStatus> {
    if (runStatus === 'needs_input' || runStatus === 'stopped') {
      return runStatus;
    }
    if ((await this.store.listPendingWakes(m.tx, m.agent.id)).length) {
      m.wakeHub(m.agent.id, 0);
      return 'waiting';
    }
    if (await this.store.hasActiveChild(m.tx, m.agent.id)) return 'waiting';
    return runStatus;
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
      return {
        answers: answered.map(q => ({
          questionId: q.question_id,
          question: q.question,
          answer: q.answer ?? '',
        })),
      };
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
    await this.startRun(id, 'message', credentials, async m => {
      if (busy(m.agent.status)) {
        throw new ConflictError(`Agent ${id} has an active run`);
      }
      return { message: text };
    });
  }

  /**
   * Deletes the active Job. The follower then sees `run.finished` with
   * `cancelled` (or the pod disappear) and sets the agent to `stopped`. A hub
   * stops its children first. A stop that comes from the hub does not wake it.
   */
  async stop(
    owner: string,
    id: string,
    opts: { byHub: boolean } = { byHub: false },
  ): Promise<void> {
    await this.stopAgent(await this.ownedAgentRow(owner, id), opts.byHub);
  }

  private async stopAgent(agent: AgentRow, byHub: boolean): Promise<void> {
    if (isTerminalAgentStatus(agent.status)) return;
    if (agent.kind === 'hub') {
      for (const child of await this.store.listChildRows(
        this.store.knex,
        agent.id,
      )) {
        await this.stopAgent(child, true);
      }
    }
    const id = agent.id;
    const run = await this.lastRun(id);
    if (run?.status === 'running') {
      await this.store.updateAgent(this.store.knex, id, {
        stop_requested: true,
        stop_by_hub: byHub,
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
        m.agent.stop_by_hub = byHub;
        await this.store.updateAgent(m.tx, id, { stop_by_hub: byHub });
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
