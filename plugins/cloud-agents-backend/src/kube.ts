import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  Log,
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
    reason: status?.state?.waiting?.reason ?? pod.status?.phase,
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

  /**
   * Creates the suspended Job, its Secret, then resumes the Job. Each step
   * accepts that an earlier attempt already did it.
   */
  async launch(launch: RunLaunch): Promise<void> {
    const namespace = this.namespace;
    let job;
    try {
      job = await this.batch.createNamespacedJob({
        namespace,
        body: buildJob(this.spec, launch),
      });
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
      job = await this.batch.readNamespacedJob({
        name: launch.jobName,
        namespace,
      });
    }
    const uid = job.metadata?.uid;
    if (!uid) throw new Error(`Job ${launch.jobName} has no uid`);
    try {
      await this.core.createNamespacedSecret({
        namespace,
        body: buildSecret(this.spec, launch, { name: launch.jobName, uid }),
      });
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
    }
    if (job.spec?.suspend) {
      job.spec.suspend = false;
      await this.batch.replaceNamespacedJob({
        name: launch.jobName,
        namespace,
        body: job,
      });
    }
  }

  /** Deletes the Job; its pod gets SIGTERM and its Secret goes with it. */
  async deleteJob(name: string): Promise<void> {
    try {
      await this.batch.deleteNamespacedJob({
        name,
        namespace: this.namespace,
        propagationPolicy: 'Background',
      });
    } catch (error) {
      if (!isStatus(error, 404)) throw error;
    }
  }

  async jobState(name: string): Promise<JobState> {
    try {
      const job = await this.batch.readNamespacedJob({
        name,
        namespace: this.namespace,
      });
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

  async runPod(runId: string): Promise<PodState | undefined> {
    const pods = await this.core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `${LABEL_RUN_ID}=${runId}`,
    });
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
    const controller = await this.log.log(
      this.namespace,
      podName,
      CONTAINER_NAME,
      stream,
      { follow, pretty: false, timestamps: false },
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
