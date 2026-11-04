import { setTimeout as sleep } from 'node:timers/promises';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { outcomeOfExitCode, type AgentService } from './agents';
import type { Cluster } from './kube';
import { parseRunnerLine } from './runnerEvents';
import type { RunRow, Store } from './store';

export interface FollowerOptions {
  /** How long to wait between pod checks while a pod is pending. */
  pollIntervalMs: number;
}

/**
 * Reads each active run's pod log and feeds the events to the agent service.
 * A follower reads the log from the start and skips the runner seqs already
 * stored, so after a Backstage restart it resumes where the database stops.
 */
export class Followers {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly agents: AgentService,
    private readonly cluster: Cluster,
    private readonly logger: LoggerService,
    private readonly options: FollowerOptions,
  ) {}

  /** Follows every run the database still lists as running. */
  async resumeAll(): Promise<void> {
    const runs = await this.store.listActiveRuns();
    if (runs.length) {
      this.logger.info(`Resuming ${runs.length} cloud agent run(s)`);
    }
    runs.forEach(run => this.follow(run));
  }

  follow(run: RunRow): void {
    if (this.active.has(run.id)) return;
    const controller = new AbortController();
    this.active.set(run.id, controller);
    this.loop(run, controller.signal)
      .catch(error => {
        if (!controller.signal.aborted) {
          this.logger.error(
            `Follower of run ${run.id} stopped: ${(error as Error).message}`,
          );
        }
      })
      .finally(() => this.active.delete(run.id));
  }

  stopAll(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  private async loop(run: RunRow, signal: AbortSignal): Promise<void> {
    const stored = await this.store.getRun(this.store.knex, run.id);
    let lastSeq = stored?.runner_seq ?? -1;
    let failures = 0;

    while (!signal.aborted) {
      try {
        const pod = await this.cluster.runPod(run.id);
        if (!pod || pod.phase === 'pending') {
          const job = await this.cluster.jobState(run.job_name);
          if (job.phase === 'failed') {
            await this.finishWithout(run, job.reason);
            return;
          }
          if (job.phase === 'absent' && !pod) {
            await this.finishWithout(
              run,
              'The runner pod disappeared before it reported run.finished',
            );
            return;
          }
          await sleep(this.options.pollIntervalMs, undefined, { signal });
          continue;
        }

        for await (const line of this.cluster.logLines(
          pod.name,
          pod.phase === 'running',
          signal,
        )) {
          const parsed = parseRunnerLine(line);
          if (!parsed.ok) {
            if (line.trim()) {
              this.logger.warn(
                `Run ${run.id}: skipped a stdout line (${parsed.error})`,
              );
            }
            continue;
          }
          if (parsed.event.seq <= lastSeq) continue;
          const done = await this.agents.ingest(run, parsed.event, parsed.raw);
          lastSeq = parsed.event.seq;
          if (done) return;
        }
        failures = 0;

        const after = await this.cluster.runPod(run.id);
        if (!after) {
          await this.finishWithout(
            run,
            'The runner pod disappeared before it reported run.finished',
          );
          return;
        }
        if (after.phase === 'terminated' && pod.phase === 'terminated') {
          await this.agents.finishRun(
            run.id,
            outcomeOfExitCode(
              after.exitCode,
              await this.agents.isStopRequested(run.agent_id),
            ),
          );
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        this.logger.warn(
          `Run ${run.id}: ${(error as Error).message}; retrying (${failures})`,
        );
        await sleep(
          Math.min(30_000, this.options.pollIntervalMs * 2 ** failures),
          undefined,
          { signal },
        ).catch(() => {});
      }
    }
  }

  private async finishWithout(run: RunRow, reason: string): Promise<void> {
    const stopped = await this.agents.isStopRequested(run.agent_id);
    await this.agents.finishRun(run.id, {
      status: stopped ? 'stopped' : 'failed',
      exitCode: null,
      prUrl: null,
      error: stopped ? null : reason,
    });
  }
}
