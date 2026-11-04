import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  KubeConfig,
  type V1Job,
  type V1Pod,
  type V1Secret,
} from '@kubernetes/client-node';

/** Reads a recorded runner stream from runner/test/streams. */
export function recordedStream(name: string): string[] {
  const file = resolve(
    __dirname,
    '../../../../runner/test/streams',
    `${name}.jsonl`,
  );
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

/** What a fake pod prints and how it ends. */
export interface PodScript {
  lines: string[];
  exitCode: number;
  /** Stop after this many lines until `release()`. */
  holdAt?: number;
  /** Lines printed after the Job is deleted, before exit 130. */
  onCancel?: string[];
  lineDelayMs?: number;
}

interface FakePod {
  pod: V1Pod;
  script: PodScript;
  printed: string[];
  next: number;
  done: boolean;
  events: EventEmitter;
  timer?: NodeJS.Timeout;
}

function withRunId(line: string, runId: string): string {
  const event = JSON.parse(line) as Record<string, unknown>;
  return JSON.stringify({ ...event, run_id: runId });
}

/**
 * A Kubernetes API server with just what the plugin calls: Jobs, Secrets, pods
 * by label, and pod logs. Unsuspending a Job starts a pod that prints a
 * scripted runner stream.
 */
export class FakeKube {
  readonly jobs = new Map<string, V1Job>();
  readonly secrets = new Map<string, V1Secret>();
  readonly pods = new Map<string, FakePod>();
  readonly requests: string[] = [];
  private server: Server | undefined;
  private uid = 0;
  /** Chooses the script of the next pod. */
  script: (job: V1Job) => PodScript = () => ({
    lines: recordedStream('opencode'),
    exitCode: 0,
  });

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(error => {
        res.statusCode = 500;
        res.end(JSON.stringify({ message: String(error) }));
      });
    });
    await new Promise<void>(r => this.server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const pod of this.pods.values()) clearTimeout(pod.timer);
    this.server?.closeAllConnections();
    await new Promise(r => this.server?.close(r));
  }

  kubeConfig(server: string): KubeConfig {
    const kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: 'fake', server, skipTLSVerify: true }],
      users: [{ name: 'fake', token: 'fake' }],
      contexts: [{ name: 'fake', cluster: 'fake', user: 'fake' }],
      currentContext: 'fake',
    });
    return kc;
  }

  podOfRun(runId: string): FakePod | undefined {
    return [...this.pods.values()].find(
      p => p.pod.metadata?.labels?.['cloud-agents/run-id'] === runId,
    );
  }

  release(runId: string): void {
    const pod = this.podOfRun(runId);
    if (!pod) throw new Error(`no pod for run ${runId}`);
    delete pod.script.holdAt;
    this.tick(pod);
  }

  /** Deletes the run's pod and Job the way a node loss would: no exit, no output. */
  vanish(runId: string): void {
    const pod = this.podOfRun(runId);
    if (!pod) throw new Error(`no pod for run ${runId}`);
    clearTimeout(pod.timer);
    this.pods.delete(pod.pod.metadata!.name!);
    for (const [name, job] of this.jobs) {
      if (job.metadata?.labels?.['cloud-agents/run-id'] === runId)
        this.jobs.delete(name);
    }
    pod.events.emit('done');
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  }

  private async body<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  }

  private notFound(res: ServerResponse): void {
    this.json(res, 404, { kind: 'Status', code: 404, message: 'not found' });
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    this.requests.push(`${req.method} ${url.pathname}`);
    const job =
      /^\/apis\/batch\/v1\/namespaces\/([^/]+)\/jobs(?:\/([^/]+))?$/.exec(
        url.pathname,
      );
    const secret = /^\/api\/v1\/namespaces\/([^/]+)\/secrets$/.exec(
      url.pathname,
    );
    const pods = /^\/api\/v1\/namespaces\/([^/]+)\/pods$/.exec(url.pathname);
    const log = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/.exec(
      url.pathname,
    );

    if (job && req.method === 'POST') {
      const body = await this.body<V1Job>(req);
      const name = body.metadata!.name!;
      if (this.jobs.has(name)) {
        this.json(res, 409, { code: 409 });
        return;
      }
      body.metadata!.uid = `uid-${++this.uid}`;
      body.metadata!.resourceVersion = '1';
      this.jobs.set(name, body);
      if (!body.spec?.suspend) this.startPod(body);
      this.json(res, 201, body);
      return;
    }
    if (job?.[2] && req.method === 'GET') {
      const found = this.jobs.get(job[2]);
      if (found) this.json(res, 200, found);
      else this.notFound(res);
      return;
    }
    if (job?.[2] && req.method === 'PATCH') {
      const found = this.jobs.get(job[2]);
      if (!found) {
        this.notFound(res);
        return;
      }
      if (req.headers['content-type'] !== 'application/merge-patch+json') {
        this.json(res, 415, { code: 415 });
        return;
      }
      const patch = await this.body<{ spec?: { suspend?: boolean } }>(req);
      found.spec = { ...found.spec!, ...patch.spec };
      if (!found.spec.suspend) this.startPod(found);
      this.json(res, 200, found);
      return;
    }
    if (job?.[2] && req.method === 'DELETE') {
      const found = this.jobs.get(job[2]);
      if (!found) {
        this.notFound(res);
        return;
      }
      this.jobs.delete(job[2]);
      for (const [name, s] of this.secrets) {
        if (
          s.metadata?.ownerReferences?.some(o => o.uid === found.metadata?.uid)
        ) {
          this.secrets.delete(name);
        }
      }
      const runId = found.metadata?.labels?.['cloud-agents/run-id'];
      const pod = runId ? this.podOfRun(runId) : undefined;
      if (pod) this.cancel(pod);
      this.json(res, 200, { kind: 'Status', status: 'Success' });
      return;
    }
    if (secret && req.method === 'POST') {
      const body = await this.body<V1Secret>(req);
      const name = body.metadata!.name!;
      if (this.secrets.has(name)) {
        this.json(res, 409, { code: 409 });
        return;
      }
      this.secrets.set(name, body);
      this.json(res, 201, body);
      return;
    }
    if (pods && req.method === 'GET') {
      const [key, value] = (url.searchParams.get('labelSelector') ?? '').split(
        '=',
      );
      const items = [...this.pods.values()]
        .map(p => p.pod)
        .filter(p => !key || p.metadata?.labels?.[key] === value);
      this.json(res, 200, { kind: 'PodList', items });
      return;
    }
    if (log && req.method === 'GET') {
      const pod = this.pods.get(log[2]!);
      if (!pod) {
        this.notFound(res);
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      for (const line of pod.printed) res.write(`${line}\n`);
      if (url.searchParams.get('follow') !== 'true' || pod.done) {
        res.end();
        return;
      }
      const onLine = (line: string) => res.write(`${line}\n`);
      const onDone = () => res.end();
      pod.events.on('line', onLine);
      pod.events.once('done', onDone);
      res.on('close', () => {
        pod.events.off('line', onLine);
        pod.events.off('done', onDone);
      });
      return;
    }
    this.notFound(res);
  }

  private startPod(job: V1Job): void {
    const labels = job.spec!.template.metadata!.labels!;
    const runId = labels['cloud-agents/run-id']!;
    if (this.podOfRun(runId)) return;
    const script = this.script(job);
    const name = `${job.metadata!.name}-pod`;
    const fake: FakePod = {
      pod: {
        metadata: { name, labels },
        status: {
          phase: 'Running',
          containerStatuses: [
            {
              name: 'runner',
              image: '',
              imageID: '',
              ready: true,
              restartCount: 0,
              state: { running: {} },
            },
          ],
        },
      },
      script: {
        ...script,
        lines: script.lines.map(l => withRunId(l, runId)),
        ...(script.onCancel && {
          onCancel: script.onCancel.map(l => withRunId(l, runId)),
        }),
      },
      printed: [],
      next: 0,
      done: false,
      events: new EventEmitter(),
    };
    this.pods.set(name, fake);
    this.tick(fake);
  }

  private tick(pod: FakePod): void {
    clearTimeout(pod.timer);
    if (pod.done) return;
    if (pod.script.holdAt !== undefined && pod.next >= pod.script.holdAt)
      return;
    const line = pod.script.lines[pod.next];
    if (line === undefined) {
      this.terminate(pod, pod.script.exitCode);
      return;
    }
    pod.timer = setTimeout(() => {
      pod.next += 1;
      this.print(pod, line);
      this.tick(pod);
    }, pod.script.lineDelayMs ?? 5);
  }

  private print(pod: FakePod, line: string): void {
    pod.printed.push(line);
    pod.events.emit('line', line);
  }

  private terminate(pod: FakePod, exitCode: number): void {
    pod.done = true;
    clearTimeout(pod.timer);
    pod.pod.status!.containerStatuses![0]!.state = {
      terminated: { exitCode },
    };
    pod.pod.status!.phase = exitCode === 0 ? 'Succeeded' : 'Failed';
    pod.events.emit('done');
  }

  private cancel(pod: FakePod): void {
    if (pod.done) {
      this.pods.delete(pod.pod.metadata!.name!);
      return;
    }
    for (const line of pod.script.onCancel ?? []) this.print(pod, line);
    this.terminate(pod, 130);
    setTimeout(() => this.pods.delete(pod.pod.metadata!.name!), 50);
  }
}
