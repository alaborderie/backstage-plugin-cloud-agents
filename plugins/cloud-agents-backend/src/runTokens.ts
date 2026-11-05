import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import {
  coreServices,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import {
  createExternalTokenHandler,
  externalTokenHandlersServiceRef,
} from '@backstage/backend-defaults/auth';
import { parseEncryptionKey } from './config';

const PREFIX = 'cahub';
/** The `type` of the `backend.auth.externalAccess` entry that accepts hub run tokens. */
export const HUB_RUN_TOKEN_TYPE = 'cloud-agents-hub-run';
/** The service principal subject of a hub run: this prefix and the run id. */
export const HUB_RUN_SUBJECT_PREFIX = 'cloud-agents-hub-run:';

/** The HMAC key of hub run tokens, derived from the credential encryption key. */
export function hubRunTokenKey(encryptionKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      encryptionKey,
      Buffer.alloc(0),
      'cloud-agents hub run token v1',
      32,
    ),
  );
}

function signature(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

/**
 * A hub run's `CLOUD_AGENT_RUN_TOKEN`: `cahub.<run id>.<expiry>.<hmac>`. It
 * proves which run it belongs to without a database read, so Backstage's auth
 * service can turn it into a service principal. The actions still check that
 * the run is active.
 */
export function signHubRunToken(
  key: Buffer,
  runId: string,
  expiresAt: Date,
): string {
  const body = `${PREFIX}.${runId}.${Math.floor(expiresAt.getTime() / 1000)}`;
  return `${body}.${signature(key, body)}`;
}

/** The run id of a valid, unexpired hub run token, else undefined. */
export function verifyHubRunToken(
  key: Buffer,
  token: string,
  now = Date.now(),
): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return undefined;
  const [, runId, expiry, given] = parts as [string, string, string, string];
  const expected = Buffer.from(signature(key, parts.slice(0, 3).join('.')));
  const actual = Buffer.from(given);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return undefined;
  }
  if (Number(expiry) * 1000 <= now) return undefined;
  return runId;
}

/**
 * Lets Backstage authenticate hub run tokens. Add it to the backend and an
 * `externalAccess` entry of type `cloud-agents-hub-run` restricted to the
 * `cloud-agents` plugin. A token then authenticates as the service principal
 * `cloud-agents-hub-run:<run id>`, which the cloud-agents actions accept for
 * that hub's children only.
 *
 * @public
 */
export const cloudAgentsHubRunTokens = createServiceFactory({
  service: externalTokenHandlersServiceRef,
  deps: { config: coreServices.rootConfig },
  factory: ({ config }) =>
    createExternalTokenHandler<{ key: Buffer }>({
      type: HUB_RUN_TOKEN_TYPE,
      initialize: () => ({
        key: hubRunTokenKey(
          parseEncryptionKey(
            config.getOptionalString('cloudAgents.encryptionKey') ??
              process.env.CLOUD_AGENTS_ENCRYPTION_KEY,
          ),
        ),
      }),
      async verifyToken(token, { key }) {
        const runId = verifyHubRunToken(key, token);
        return runId
          ? { subject: `${HUB_RUN_SUBJECT_PREFIX}${runId}` }
          : undefined;
      },
    }),
});
