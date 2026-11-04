import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  Log,
  PatchStrategy,
  setHeaderOptions,
  type V1Pod,
} from '@kubernetes/client-node';
import {
  buildJob,
  buildSecret,
  CONTAINER_NAME,
  LABEL_RUN_ID,
  type JobSpecConfig,
  type RunLaunch,
} from './jobSpec';

/** What the follower needs to know about a run's pod. */
export type PodState =
  | { phase: 'pending'; name: string; reason: string | undefined }
  | { phase: 'running'; name: string }
  | { phase: 'terminated'; name: string; exitCode: number };

export type JobState =
  | { phase: 'absent' }
  | { phase: 'active' }
  | { phase: 'failed'; reason: string };

function isStatus(error: unknown, code: number): boolean {
  return error instanceof ApiException && error.code === code;
}

/** A Kubernetes request rejected permanently, rather than a transient outage. */
export class KubernetesRefusal extends Error {}

function statusMessage(error: ApiException<unknown>): string {
  let body: unknown = error.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return `HTTP ${error.code}`;
    }
  }
  return body &&
    typeof body === 'object' &&
    'message' in body &&
    typeof body.message === 'string'
    ? body.message
    : `HTTP ${error.code}`;
}

function podState(pod: V1Pod): PodState {
  const name = pod.metadata?.name ?? '';
  const status = pod.status?.containerStatuses?.find(
    c => c.name === CONTAINER_NAME,
  );
  if (status?.state?.terminated) {
    return {
      phase: 'terminated',
      name,
      exitCode: status.state.terminated.exitCode,
    };
  }
  if (status?.state?.running) return { phase: 'running', name };
  return {
    phase: 'pending',
    name,
    reason:
      status?.state?.waiting?.message ??
      status?.state?.waiting?.reason ??
      pod.status?.conditions?.find(
        c => c.type === 'PodScheduled' && c.status === 'False',
      )?.message ??
      pod.status?.message ??
      pod.status?.phase,
  };
}

/** The Kubernetes calls of the plugin, all in one namespace. */
export class Cluster {
  private readonly batch: BatchV1Api;
  private readonly core: CoreV1Api;
  private readonly log: Log;

  constructor(kubeConfig: KubeConfig, private readonly spec: JobSpecConfig) {
    this.batch = kubeConfig.makeApiClient(BatchV1Api);
    this.core = kubeConfig.makeApiClient(CoreV1Api);
    this.log = new Log(kubeConfig);
  }

  private get namespace(): string {
    return this.spec.namespace;
  }

  private async request<T>(
    operation: string,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (
        error instanceof ApiException &&
        error.code >= 400 &&
        error.code < 500 &&
        ![404, 409, 429].includes(error.code)
      ) {
        throw new KubernetesRefusal(
          `Kubernetes ${operation} in namespace ${
            this.namespace
          } refused (HTTP ${error.code}): ${statusMessage(error)}`,
        );
      }
      throw error;
    }
  }

  /**
   * Creates the suspended Job, its Secret, then resumes the Job. Each step
   * accepts that an earlier attempt already did it.
   */
  async launch(launch: RunLaunch): Promise<void> {
    const namespace = this.namespace;
    let job;
    try {
      job = await this.request('create jobs', () =>
        this.batch.createNamespacedJob({
          namespace,
          body: buildJob(this.spec, launch),
        }),
      );
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
      job = await this.request('get jobs', () =>
        this.batch.readNamespacedJob({
          name: launch.jobName,
          namespace,
        }),
      );
    }
    const uid = job.metadata?.uid;
    if (!uid) throw new Error(`Job ${launch.jobName} has no uid`);
    try {
      await this.request('create secrets', () =>
        this.core.createNamespacedSecret({
          namespace,
          body: buildSecret(this.spec, launch, { name: launch.jobName, uid }),
        }),
      );
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
    }
    if (job.spec?.suspend) {
      await this.request('patch jobs', () =>
        this.batch.patchNamespacedJob(
          {
            name: launch.jobName,
            namespace,
            body: { spec: { suspend: false } },
          },
          setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
        ),
      );
    }
  }

  /** Deletes the Job; its pod gets SIGTERM and its Secret goes with it. */
  async deleteJob(name: string): Promise<void> {
    try {
      await this.request('delete jobs', () =>
        this.batch.deleteNamespacedJob({
          name,
          namespace: this.namespace,
          propagationPolicy: 'Background',
        }),
      );
    } catch (error) {
      if (!isStatus(error, 404)) throw error;
    }
  }

  async jobState(name: string): Promise<JobState> {
    try {
      const job = await this.request('get jobs', () =>
        this.batch.readNamespacedJob({
          name,
          namespace: this.namespace,
        }),
      );
      const failed = job.status?.conditions?.find(
        c => c.type === 'Failed' && c.status === 'True',
      );
      return failed
        ? {
            phase: 'failed',
            reason: failed.message ?? failed.reason ?? 'Job failed',
          }
        : { phase: 'active' };
    } catch (error) {
      if (isStatus(error, 404)) return { phase: 'absent' };
      throw error;
    }
  }

  /** Admission failures belong to the Job, since no pod exists yet. */
  async jobRejection(name: string): Promise<string | undefined> {
    const events = await this.request('list events', () =>
      this.core.listNamespacedEvent({
        namespace: this.namespace,
        fieldSelector: `involvedObject.kind=Job,involvedObject.name=${name},reason=FailedCreate`,
      }),
    );
    const failure = events.items.find(event => event.reason === 'FailedCreate');
    return failure
      ? `Job ${name}: ${failure.message ?? 'FailedCreate'}`
      : undefined;
  }

  async runPod(runId: string): Promise<PodState | undefined> {
    const pods = await this.request('list pods', () =>
      this.core.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `${LABEL_RUN_ID}=${runId}`,
      }),
    );
    const pod =
      pods.items.find(p => !p.metadata?.deletionTimestamp) ?? pods.items[0];
    return pod ? podState(pod) : undefined;
  }

  /**
   * The pod's stdout from the start, line by line. With `follow`, it ends when
   * the container exits or the API server closes the stream.
   */
  async *logLines(
    podName: string,
    follow: boolean,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const stream = new PassThrough();
    const controller = await this.request('get pods/log', () =>
      this.log.log(this.namespace, podName, CONTAINER_NAME, stream, {
        follow,
        pretty: false,
        timestamps: false,
      }),
    );
    const abort = () => {
      controller.abort();
      stream.end();
    };
    signal.addEventListener('abort', abort, { once: true });
    stream.on('error', () => stream.end());
    try {
      for await (const line of createInterface({ input: stream })) {
        yield line;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}
