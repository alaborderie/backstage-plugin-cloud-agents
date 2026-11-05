import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod';
import type {
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { InputError, ServiceUnavailableError } from '@backstage/errors';
import type { TurnEvent } from '@alaborderie/plugin-assistant-common';
import type { Assistant, Caller } from './assistant';
import type { Store } from './store';

const PING_INTERVAL_MS = 15_000;
const messageBody = z.object({ text: z.string().trim().min(1).max(32_000) });

export function createRouter(deps: {
  assistant: Assistant;
  store: Store;
  httpAuth: HttpAuthService;
  logger: LoggerService;
}): express.Router {
  const { assistant, store, httpAuth, logger } = deps;
  const router = Router();
  router.use(express.json({ limit: '256kb' }));

  async function callerOf(req: express.Request): Promise<Caller> {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    return {
      credentials,
      userEntityRef: credentials.principal.userEntityRef,
    };
  }

  router.get('/conversations', async (req, res) => {
    const { userEntityRef } = await callerOf(req);
    res.json({ conversations: await store.listConversations(userEntityRef) });
  });

  router.post('/conversations', async (req, res) => {
    const { userEntityRef } = await callerOf(req);
    res.status(201).json(await store.createConversation(userEntityRef));
  });

  router.get('/conversations/:id', async (req, res) => {
    const { userEntityRef } = await callerOf(req);
    const conversation = await store.getConversation(
      userEntityRef,
      req.params.id,
    );
    res.json({ conversation, items: await store.listItems(conversation.id) });
  });

  router.post('/conversations/:id/messages', async (req, res) => {
    const caller = await callerOf(req);
    const body = messageBody.safeParse(req.body);
    if (!body.success) throw new InputError('text must be a non-empty string');
    if (!assistant.ready) {
      throw new ServiceUnavailableError(
        'The assistant has no chat model key (assistant.chatModel.apiKey)',
      );
    }
    await store.getConversation(caller.userEntityRef, req.params.id);

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    let open = false;
    let ping: NodeJS.Timeout | undefined;
    const emit = (event: TurnEvent) => {
      if (!open) {
        open = true;
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        ping = setInterval(() => res.write(': ping\n\n'), PING_INTERVAL_MS);
      }
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      (res as unknown as { flush?: () => void }).flush?.();
    };
    try {
      await assistant.runTurn(
        caller,
        req.params.id,
        body.data.text,
        emit,
        abort.signal,
      );
    } catch (error) {
      if (!open) throw error;
      if (!abort.signal.aborted) {
        logger.warn(`A turn failed: ${(error as Error).message}`);
        emit({ type: 'error', message: (error as Error).message });
      }
    } finally {
      clearInterval(ping);
      if (open) res.end();
    }
  });

  router.post(
    '/conversations/:id/agents/:agentId/summary',
    async (req, res) => {
      const caller = await callerOf(req);
      if (!assistant.ready) {
        throw new ServiceUnavailableError(
          'The assistant has no chat model key',
        );
      }
      res.json({
        item: await assistant.summarize(
          caller,
          req.params.id,
          req.params.agentId,
        ),
      });
    },
  );

  return router;
}
