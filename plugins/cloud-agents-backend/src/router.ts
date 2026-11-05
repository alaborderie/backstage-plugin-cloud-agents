import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod';
import type {
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import {
  AuthenticationError,
  InputError,
  NotAllowedError,
  NotFoundError,
} from '@backstage/errors';
import {
  AGENT_KINDS,
  AGENT_STATUSES,
  HARNESSES,
  type AccessToken,
  type CreatedAccessToken,
} from '@alaborderie/plugin-cloud-agents-common';
import type { AgentService } from './agents';
import type { CloudAgentsConfig } from './config';
import { MissingCredentialError, type CredentialService } from './credentials';
import { randomToken, sha256Hex } from './crypto';
import type { GithubClient } from './github';
import { nowIso, type EventRow, type Store } from './store';

const PING_INTERVAL_MS = 15_000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_PREFIX = 'cat_';

const nonEmpty = z.string().trim().min(1);

const createAgentBody = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo must be owner/name'),
    base: nonEmpty.optional(),
    branch: z
      .string()
      .regex(
        /^(?!\/|.*\/\/|.*\.\.|.*\/$)[\w./-]+$/,
        'branch is not a valid ref',
      )
      .optional(),
    prompt: nonEmpty,
    title: z.string().optional(),
    tier: nonEmpty.optional(),
    harness: z.enum(HARNESSES as [string, ...string[]]).optional(),
    model: nonEmpty.optional(),
    effort: nonEmpty.optional(),
    parent: z
      .object({
        source: nonEmpty,
        threadId: z.string().optional(),
        label: z.string().optional(),
      })
      .optional(),
    kind: z.enum(AGENT_KINDS as [string, ...string[]]).optional(),
  })
  .strip();

/** The JSON a hub keeps between runs: any value of at most 64 KiB. */
const HUB_STATE_MAX_BYTES = 64 * 1024;

const replyBody = z.object({ questionId: nonEmpty, answer: nonEmpty });
const messageBody = z.object({ text: nonEmpty });
const credentialBody = z.object({
  value: nonEmpty.max(64 * 1024),
  kind: z.enum(['api_key', 'auth_json']).optional(),
});
const tokenBody = z.object({ name: nonEmpty.max(200) });
const credentialName = z.enum([
  'claude',
  'codex',
  'opencode',
  'github',
  'anthropic',
]);
const anthropicKeyBody = z.object({ userEntityRef: nonEmpty });

/** The only caller of `POST /service/anthropic-key`. */
const ASSISTANT_SUBJECT = 'plugin:assistant';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new InputError(
      `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`,
    );
  }
  return result.data;
}

/** `id`/`data` framing of one stored event, per docs/API.md. */
export function sseMessage(row: EventRow): string {
  return `id: ${row.seq}\nevent: agent-event\ndata: {"seq":${
    row.seq
  },"runId":${JSON.stringify(row.run_id)},"event":${row.data}}\n\n`;
}

export interface RouterDeps {
  config: CloudAgentsConfig;
  agents: AgentService;
  credentials: CredentialService;
  github: GithubClient;
  store: Store;
  httpAuth: HttpAuthService;
  logger: LoggerService;
}

export function createRouter(deps: RouterDeps): express.Router {
  const { agents, credentials, github, store, httpAuth, config, logger } = deps;
  const router = Router();
  router.use(express.json({ limit: '1mb' }));

  /**
   * The user a request acts as: a `cat_` personal access token, or the
   * caller's Backstage user credentials.
   */
  async function ownerOf(req: express.Request): Promise<string> {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (match?.[1]?.startsWith(TOKEN_PREFIX)) {
      const row = await store.findAccessToken(sha256Hex(match[1]));
      if (!row) throw new AuthenticationError('Unknown access token');
      await store.touchAccessToken(row.id);
      return row.owner_ref;
    }
    const creds = await httpAuth.credentials(req, { allow: ['user'] });
    return creds.principal.userEntityRef;
  }

  router.post('/agents', async (req, res) => {
    const owner = await ownerOf(req);
    const body = parse(createAgentBody, req.body);
    const agent = await agents.createAgent(owner, {
      repo: body.repo,
      prompt: body.prompt,
      ...(body.base !== undefined && { base: body.base }),
      ...(body.branch !== undefined && { branch: body.branch }),
      ...(body.title !== undefined && { title: body.title }),
      ...(body.tier !== undefined && { tier: body.tier }),
      ...(body.harness !== undefined && {
        harness: body.harness as (typeof HARNESSES)[number],
      }),
      ...(body.model !== undefined && { model: body.model }),
      ...(body.effort !== undefined && { effort: body.effort }),
      ...(body.kind !== undefined && {
        kind: body.kind as (typeof AGENT_KINDS)[number],
      }),
      ...(body.parent !== undefined && {
        parent: {
          source: body.parent.source,
          ...(body.parent.threadId !== undefined && {
            threadId: body.parent.threadId,
          }),
          ...(body.parent.label !== undefined && { label: body.parent.label }),
        },
      }),
    });
    res.status(201).json(agent);
  });

  router.get('/agents', async (req, res) => {
    const owner = await ownerOf(req);
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? parse(
            z.enum(AGENT_STATUSES as [string, ...string[]]),
            req.query.status,
          )
        : undefined;
    const parentId =
      typeof req.query.parentId === 'string' && req.query.parentId
        ? req.query.parentId
        : undefined;
    res.json(
      await agents.listAgents(owner, {
        ...(status !== undefined && {
          status: status as (typeof AGENT_STATUSES)[number],
        }),
        ...(parentId !== undefined && { parentId }),
      }),
    );
  });

  router.get('/agents/:id', async (req, res) => {
    res.json(await agents.getAgent(await ownerOf(req), req.params.id));
  });

  router.get('/agents/:id/events', async (req, res) => {
    const owner = await ownerOf(req);
    const resumeFrom = req.header('last-event-id') ?? req.query.after;
    const after =
      typeof resumeFrom === 'string' && resumeFrom !== ''
        ? Number(resumeFrom)
        : 0;
    if (!Number.isInteger(after) || after < 0) {
      throw new InputError('Last-Event-ID and after must be a seq');
    }
    await agents.getAgent(owner, req.params.id);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const write = (chunk: string) => {
      res.write(chunk);
      (res as unknown as { flush?: () => void }).flush?.();
    };
    write(': connected\n\n');
    const ping = setInterval(() => write(': ping\n\n'), PING_INTERVAL_MS);
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      res.end();
    };
    const handle = await agents.openStream(
      owner,
      req.params.id,
      after,
      row => write(sseMessage(row)),
      finish,
    );
    req.on('close', () => {
      handle.close();
      finish();
    });
  });

  router.post('/agents/:id/reply', async (req, res) => {
    const owner = await ownerOf(req);
    const body = parse(replyBody, req.body);
    await agents.reply(owner, req.params.id, body.questionId, body.answer);
    res.status(202).json(await agents.getAgent(owner, req.params.id));
  });

  router.post('/agents/:id/messages', async (req, res) => {
    const owner = await ownerOf(req);
    const body = parse(messageBody, req.body);
    await agents.message(owner, req.params.id, body.text);
    res.status(202).json(await agents.getAgent(owner, req.params.id));
  });

  router.post('/agents/:id/stop', async (req, res) => {
    const owner = await ownerOf(req);
    await agents.stop(owner, req.params.id);
    res.status(202).json(await agents.getAgent(owner, req.params.id));
  });

  /**
   * A runner pod's current GitHub token. The pod authenticates with its run's
   * token, which works only while the run is active.
   */
  router.get('/runner/github-token', async (req, res) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const agent = match?.[1]
      ? await store.findActiveRunAgent(sha256Hex(match[1]))
      : undefined;
    if (!agent) throw new AuthenticationError('Unknown or finished run');
    const token = await credentials.githubTokenForActiveRun(
      agent.owner_ref,
      agent.harness,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token });
  });

  /** The hub of an active hub run, from the run's token. */
  async function hubOfRun(req: express.Request): Promise<string> {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const agent = match?.[1]
      ? await store.findActiveRunAgent(sha256Hex(match[1]))
      : undefined;
    if (agent?.kind !== 'hub') {
      throw new AuthenticationError('Unknown or finished hub run');
    }
    return agent.id;
  }

  /** `read_state`: the JSON the hub's last `write_state` stored, or null. */
  router.get('/runner/hub/state', async (req, res) => {
    const hubId = await hubOfRun(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ state: await agents.hubState(hubId) });
  });

  /** `write_state`: `{"state": <any JSON>}`, at most 64 KiB. */
  router.put('/runner/hub/state', async (req, res) => {
    const hubId = await hubOfRun(req);
    if (!req.body || typeof req.body !== 'object' || !('state' in req.body)) {
      throw new InputError('Give {"state": <any JSON value>}');
    }
    const state: unknown = req.body.state;
    if (Buffer.byteLength(JSON.stringify(state)) > HUB_STATE_MAX_BYTES) {
      throw new InputError('state is larger than 64 KiB');
    }
    await agents.setHubState(hubId, state);
    res.json({});
  });

  router.get('/me/credentials', async (req, res) => {
    res.json(await credentials.summary(await ownerOf(req)));
  });

  router.put('/me/credentials/:name', async (req, res) => {
    const owner = await ownerOf(req);
    const name = parse(credentialName, req.params.name);
    const body = parse(credentialBody, req.body);
    if (name === 'github') {
      await credentials.putGithubToken(owner, body.value);
    } else if (name === 'anthropic') {
      await credentials.putAnthropicKey(owner, body.value);
    } else {
      if (body.kind && name !== 'codex') {
        throw new InputError('kind is only for codex');
      }
      await credentials.putHarness(owner, name, body.value, body.kind);
    }
    res.json(await credentials.summary(owner));
  });

  router.delete('/me/credentials/:name', async (req, res) => {
    const owner = await ownerOf(req);
    await credentials.delete(owner, parse(credentialName, req.params.name));
    res.json(await credentials.summary(owner));
  });

  router.post('/service/anthropic-key', async (req, res) => {
    const creds = await httpAuth.credentials(req, { allow: ['service'] });
    if (creds.principal.subject !== ASSISTANT_SUBJECT) {
      throw new NotAllowedError('Only the assistant plugin reads this key');
    }
    const { userEntityRef } = parse(anthropicKeyBody, req.body);
    res.json({ apiKey: await credentials.anthropicKey(userEntityRef) });
  });

  router.get('/me/github/connect', async (req, res) => {
    const owner = await ownerOf(req);
    if (!github.app) {
      throw new NotFoundError('No GitHub App is configured for cloud agents');
    }
    const state = randomToken(24);
    await store.insertOauthState(sha256Hex(state), owner);
    const url = github.authorizeUrl(state, config.githubCallbackUrl);
    if (req.accepts(['html', 'json']) === 'json') {
      res.json({ url });
    } else {
      res.redirect(302, url);
    }
  });

  router.get('/me/github/callback', async (req, res) => {
    const back = new URL(config.settingsPageUrl);
    const { code, state, error } = req.query;
    if (typeof error === 'string') {
      back.searchParams.set('github', 'denied');
      res.redirect(302, back.toString());
      return;
    }
    if (typeof code !== 'string' || typeof state !== 'string') {
      throw new InputError('code and state are required');
    }
    const owner = await store.takeOauthState(
      sha256Hex(state),
      new Date(Date.now() - OAUTH_STATE_TTL_MS).toISOString(),
    );
    if (!owner) {
      throw new AuthenticationError('Unknown or expired GitHub authorization');
    }
    try {
      const tokens = await github.exchangeCode(code, config.githubCallbackUrl);
      await credentials.putGithubOauth(owner, tokens);
      back.searchParams.set('github', 'connected');
    } catch (e) {
      logger.warn(`GitHub connect of ${owner} failed: ${(e as Error).message}`);
      back.searchParams.set('github', 'failed');
    }
    res.redirect(302, back.toString());
  });

  router.post('/me/tokens', async (req, res) => {
    const owner = await ownerOf(req);
    const body = parse(tokenBody, req.body);
    const token = `${TOKEN_PREFIX}${randomToken(32)}`;
    const id = `tok_${randomToken(9)}`;
    await store.insertAccessToken({
      id,
      owner_ref: owner,
      name: body.name,
      token_hash: sha256Hex(token),
      created_at: nowIso(),
      last_used_at: null,
    });
    logger.info(`Created access token ${id} for ${owner}`);
    const created: CreatedAccessToken = { id, token };
    res.status(201).json(created);
  });

  router.get('/me/tokens', async (req, res) => {
    const rows = await store.listAccessTokens(await ownerOf(req));
    const tokens: AccessToken[] = rows.map(row => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
    res.json(tokens);
  });

  router.delete('/me/tokens/:id', async (req, res) => {
    const owner = await ownerOf(req);
    if (!(await store.deleteAccessToken(owner, req.params.id))) {
      throw new NotFoundError(`No token ${req.params.id}`);
    }
    res.status(204).end();
  });

  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (error instanceof MissingCredentialError) {
        res.status(422).json({
          error: 'missing_credential',
          harness: error.harness,
          credential: error.credential,
        });
        return;
      }
      next(error);
    },
  );

  return router;
}
