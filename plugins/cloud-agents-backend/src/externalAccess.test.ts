import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authServiceFactory } from '@backstage/backend-defaults/auth';
import { actionsRegistryServiceFactory } from '@backstage/backend-defaults/alpha';
import { httpAuthServiceFactory } from '@backstage/backend-defaults/httpAuth';
import {
  mockServices,
  startTestBackend,
  TestDatabases,
} from '@backstage/backend-test-utils';
import { FakeKube } from './__testUtils__/fakeKube';
import { ENCRYPTION_KEY } from './__testUtils__/harness';
import { cloudAgentsPlugin } from './plugin';
import {
  cloudAgentsHubRunTokens,
  hubRunTokenKey,
  signHubRunToken,
} from './runTokens';

const databases = TestDatabases.create({ ids: ['SQLITE_3'] });

function agentRow(id: string, kind: string, parentId: string | null) {
  return {
    id,
    owner_ref: 'user:default/alice',
    kind,
    parent_id: parentId,
    title: id,
    repo: 'acme/app',
    base: 'main',
    branch: `cloud-agent/${id}`,
    harness: 'opencode',
    model: 'm',
    effort: 'high',
    prompt: 'p',
    status: 'running',
    created_at: '2026-11-05T00:00:00.000Z',
    updated_at: '2026-11-05T00:00:00.000Z',
  };
}

/**
 * The backend wiring the app uses, with Backstage's own auth services: the
 * `externalAccess` entry and `cloudAgentsHubRunTokens` let a hub run token
 * reach the actions, and nothing else.
 */
it('authenticates a hub run token through backend.auth.externalAccess for the actions only', async () => {
  const knex = await databases.init('SQLITE_3');
  const kube = new FakeKube();
  const dir = mkdtempSync(join(tmpdir(), 'cloud-agents-'));
  writeFileSync(
    join(dir, 'kubeconfig'),
    kube.kubeConfig(await kube.start()).exportConfig(),
  );
  process.env.KUBECONFIG = join(dir, 'kubeconfig');
  const backend = await startTestBackend({
    features: [
      cloudAgentsPlugin,
      cloudAgentsHubRunTokens,
      authServiceFactory,
      httpAuthServiceFactory,
      actionsRegistryServiceFactory,
      mockServices.database.factory({ knex }),
      mockServices.rootConfig.factory({
        data: {
          app: { baseUrl: 'http://localhost:3000' },
          backend: {
            baseUrl: 'http://localhost:7007',
            auth: {
              externalAccess: [
                {
                  type: 'cloud-agents-hub-run',
                  options: {},
                  accessRestrictions: [{ plugin: 'cloud-agents' }],
                },
              ],
            },
            actions: { pluginSources: ['cloud-agents'] },
          },
          cloudAgents: {
            runnerImage: 'runner:test',
            encryptionKey: ENCRYPTION_KEY,
            runnerBackendUrl: 'http://backstage.test',
          },
        },
      }),
    ],
  });
  try {
    await knex('agents').insert([
      agentRow('ag_hub', 'hub', null),
      agentRow('ag_child', 'task', 'ag_hub'),
      agentRow('ag_other', 'task', null),
    ]);
    await knex('runs').insert({
      id: 'run-hub-1',
      agent_id: 'ag_hub',
      ordinal: 1,
      reason: 'initial',
      status: 'running',
      job_name: 'cloud-agent-hub-1',
      started_at: '2026-11-05T00:00:00.000Z',
    });
    const key = hubRunTokenKey(Buffer.from(ENCRYPTION_KEY, 'base64'));
    const token = signHubRunToken(
      key,
      'run-hub-1',
      new Date(Date.now() + 60_000),
    );
    const base = `http://127.0.0.1:${
      (backend.server.address() as AddressInfo).port
    }/api/cloud-agents`;
    const post = (name: string, input: unknown, bearer = token) =>
      fetch(
        `${base}/.backstage/actions/v1/actions/cloud-agents:${name}/invoke`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        },
      );

    const listed = await post('list-agents', {});
    expect(listed.status).toBe(200);
    expect(
      (
        (await listed.json()) as { output: { agents: Array<{ id: string }> } }
      ).output.agents.map(a => a.id),
    ).toEqual(['ag_child']);
    expect((await post('get-agent', { id: 'ag_other' })).status).toBe(403);
    expect(
      (
        await post(
          'get-agent',
          { id: 'ag_child' },
          'cahub.run-hub-1.9999999999.forged',
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/agents`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
    const actions = await fetch(`${base}/.backstage/actions/v1/actions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(
      ((await actions.json()) as { actions: Array<{ id: string }> }).actions
        .length,
    ).toBe(6);
  } finally {
    await backend.stop();
    await kube.stop();
  }
});
