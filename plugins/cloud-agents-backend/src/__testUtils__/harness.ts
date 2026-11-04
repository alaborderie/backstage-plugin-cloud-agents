import { writeFileSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Knex } from 'knex';
import {
  coreServices,
  createServiceFactory,
  type LoggerService,
  type RootLoggerService,
} from '@backstage/backend-plugin-api';
import {
  mockServices,
  startTestBackend,
  type TestBackend,
} from '@backstage/backend-test-utils';
import type { FakeKube } from './fakeKube';
import { cloudAgentsPlugin } from '../plugin';

/** Every log line the backend wrote, to check that no credential leaks. */
export class CapturedLogs {
  readonly lines: string[] = [];

  logger(fields: Record<string, unknown> = {}): RootLoggerService {
    const write =
      (level: string) => (message: string, meta?: Error | object) => {
        this.lines.push(
          JSON.stringify({
            level,
            message,
            ...fields,
            meta: String(meta ?? ''),
          }),
        );
      };
    const logger: LoggerService = {
      error: write('error'),
      warn: write('warn'),
      info: write('info'),
      debug: write('debug'),
      child: meta => this.logger({ ...fields, ...meta }),
    };
    return logger as RootLoggerService;
  }

  text(): string {
    return this.lines.join('\n');
  }
}

/** A GitHub API stand-in: `/user` names the token's owner, and the OAuth token endpoint. */
/**
 * A GitHub stand-in: `/user` names a token's owner, and the OAuth token
 * endpoint trades `codes` and refresh tokens for new tokens.
 */
export async function startFakeGithub(): Promise<{
  url: string;
  close(): Promise<void>;
  logins: Map<string, string>;
  codes: Map<string, string>;
  tokenRequests: Array<Record<string, string>>;
}> {
  const logins = new Map<string, string>();
  const codes = new Map<string, string>();
  const tokenRequests: Array<Record<string, string>> = [];
  let issued = 0;
  const server: Server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (req.url === '/user' && logins.has(token)) {
      res.end(JSON.stringify({ login: logins.get(token) }));
      return;
    }
    if (req.url === '/login/oauth/access_token' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        string
      >;
      tokenRequests.push(body);
      const login = body.code
        ? codes.get(body.code)
        : logins.get(`refresh:${body.refresh_token}`);
      if (!login || body.client_secret !== 'app-secret') {
        res.end(JSON.stringify({ error: 'bad_verification_code' }));
        return;
      }
      if (body.code) codes.delete(body.code);
      issued += 1;
      const access = `ghu_issued_${issued}`;
      const refresh = `ghr_issued_${issued}`;
      logins.set(access, login);
      logins.set(`refresh:${refresh}`, login);
      res.end(
        JSON.stringify({
          access_token: access,
          expires_in: 28800,
          refresh_token: refresh,
          refresh_token_expires_in: 15897600,
        }),
      );
      return;
    }
    res.statusCode = 401;
    res.end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    logins,
    codes,
    tokenRequests,
    close: () => new Promise(r => server.close(() => r())),
  };
}

export const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export async function startPluginBackend(options: {
  knex: Knex;
  kube: FakeKube;
  kubeUrl: string;
  githubUrl: string;
  logs: CapturedLogs;
  githubApp?: boolean;
}): Promise<{ backend: TestBackend; baseUrl: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-agents-'));
  const kubeconfigPath = join(dir, 'kubeconfig');
  writeFileSync(
    kubeconfigPath,
    options.kube.kubeConfig(options.kubeUrl).exportConfig(),
  );
  process.env.KUBECONFIG = kubeconfigPath;

  const backend = await startTestBackend({
    features: [
      cloudAgentsPlugin,
      mockServices.database.factory({ knex: options.knex }),
      createServiceFactory({
        service: coreServices.rootLogger,
        deps: {},
        factory: () => options.logs.logger(),
      }),
      mockServices.rootConfig.factory({
        data: {
          app: { baseUrl: 'http://localhost:3000' },
          backend: { baseUrl: 'http://localhost:7007' },
          cloudAgents: {
            namespace: 'agents-test',
            runnerImage: 'runner:test',
            encryptionKey: ENCRYPTION_KEY,
            pollIntervalMs: 20,
            github: {
              apiBaseUrl: options.githubUrl,
              ...(options.githubApp && {
                webBaseUrl: options.githubUrl,
                clientId: 'app-client',
                clientSecret: 'app-secret',
              }),
            },
          },
        },
      }),
    ],
  });
  const address = backend.server.address() as AddressInfo;
  return {
    backend,
    baseUrl: `http://127.0.0.1:${address.port}/api/cloud-agents`,
  };
}

export interface SseMessage {
  id: number;
  event: string;
  data: {
    seq: number;
    runId: string;
    event: { type: string; [k: string]: unknown };
  };
}

/** Reads an SSE stream until the server closes it, or `until` matches. */
export async function readSse(
  url: string,
  headers: Record<string, string>,
  until?: (messages: SseMessage[]) => boolean,
  timeoutMs = 15_000,
): Promise<{ messages: SseMessage[]; closedByServer: boolean; raw: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { headers, signal: controller.signal });
  if (response.status !== 200) {
    clearTimeout(timer);
    throw new Error(
      `SSE ${url}: HTTP ${response.status} ${await response.text()}`,
    );
  }
  const messages: SseMessage[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let closedByServer = false;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const text = decoder.decode(chunk, { stream: true });
      raw += text;
      buffer += text;
      for (
        let index = buffer.indexOf('\n\n');
        index >= 0;
        index = buffer.indexOf('\n\n')
      ) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const fields = Object.fromEntries(
          block
            .split('\n')
            .filter(l => !l.startsWith(':'))
            .map(l => [
              l.slice(0, l.indexOf(':')),
              l.slice(l.indexOf(':') + 2),
            ]),
        );
        if (fields.data) {
          messages.push({
            id: Number(fields.id),
            event: fields.event ?? '',
            data: JSON.parse(fields.data),
          });
        }
      }
      if (until?.(messages)) {
        controller.abort();
        return { messages, closedByServer, raw };
      }
    }
    closedByServer = true;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    if (!until) throw new Error(`SSE ${url} timed out`);
  } finally {
    clearTimeout(timer);
  }
  return { messages, closedByServer, raw };
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 25));
  }
}
