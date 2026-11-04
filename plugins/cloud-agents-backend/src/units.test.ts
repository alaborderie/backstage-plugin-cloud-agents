import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigReader } from '@backstage/config';
import { DEFAULT_TIERS } from '@alaborderie/plugin-cloud-agents-common';
import { readCloudAgentsConfig } from './config';
import { CredentialCipher } from './crypto';
import { buildJob, buildSecret, jobNameFor, type RunLaunch } from './jobSpec';
import { parseRunnerLine } from './runnerEvents';
import schema from './schema/events.v1.schema.json';
import { outcomeOfExitCode } from './agents';

const key = Buffer.alloc(32, 1);

describe('CredentialCipher', () => {
  const cipher = new CredentialCipher(key);

  it('round-trips a value and never stores it in clear', () => {
    const sealed = cipher.seal('top-secret-value', 'user:default/a\nclaude');
    expect(sealed).not.toContain('top-secret-value');
    expect(cipher.open(sealed, 'user:default/a\nclaude')).toBe(
      'top-secret-value',
    );
  });

  it('refuses a ciphertext moved to another user or credential, or tampered with', () => {
    const sealed = cipher.seal('v', 'user:default/a\nclaude');
    expect(() => cipher.open(sealed, 'user:default/b\nclaude')).toThrow();
    expect(() => cipher.open(sealed, 'user:default/a\ncodex')).toThrow();
    const parts = sealed.split(':');
    parts[3] = Buffer.from('w').toString('base64');
    expect(() =>
      cipher.open(parts.join(':'), 'user:default/a\nclaude'),
    ).toThrow();
    expect(() =>
      new CredentialCipher(Buffer.alloc(32, 2)).open(
        sealed,
        'user:default/a\nclaude',
      ),
    ).toThrow();
  });
});

describe('the bundled event schema', () => {
  it('is the runner schema unchanged', () => {
    const runner = readFileSync(
      resolve(__dirname, '../../../runner/schema/events.v1.schema.json'),
      'utf8',
    );
    expect(schema).toEqual(JSON.parse(runner));
  });

  it('accepts every recorded stream line and rejects unknown fields', () => {
    const dir = resolve(__dirname, '../../../runner/test/streams');
    for (const name of [
      'claude',
      'codex',
      'opencode',
      'opencode-needs-input',
      'opencode-cancelled',
    ]) {
      for (const line of readFileSync(resolve(dir, `${name}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)) {
        expect(parseRunnerLine(line)).toMatchObject({ ok: true, raw: line });
      }
    }
    const extra = JSON.stringify({
      v: 1,
      seq: 0,
      ts: '2026-11-04T00:00:00Z',
      run_id: 'r',
      type: 'log',
      level: 'info',
      source: 'runner',
      message: 'm',
      extra: 1,
    });
    expect(parseRunnerLine(extra).ok).toBe(false);
    expect(parseRunnerLine('not json')).toEqual({
      ok: false,
      error: 'not JSON',
    });
  });
});

describe('readCloudAgentsConfig', () => {
  const base = {
    app: { baseUrl: 'https://bs.example/' },
    backend: { baseUrl: 'https://bs.example' },
  };

  it('reads the deployment env when app-config leaves keys out', () => {
    const cfg = readCloudAgentsConfig(new ConfigReader(base), {
      CLOUD_AGENTS_NAMESPACE: 'agents',
      CLOUD_AGENTS_RUNNER_IMAGE: 'img:1',
      CLOUD_AGENTS_ENCRYPTION_KEY: key.toString('base64'),
      AUTH_GITHUB_CLIENT_ID: 'id',
      AUTH_GITHUB_CLIENT_SECRET: 'secret',
    });
    expect(cfg).toMatchObject({
      namespace: 'agents',
      runnerImage: 'img:1',
      githubApp: { clientId: 'id' },
    });
    expect([...cfg.tiers.values()]).toEqual(DEFAULT_TIERS);
    expect(cfg.settingsPageUrl).toBe(
      'https://bs.example/cloud-agents/settings',
    );
    expect(cfg.githubCallbackUrl).toBe(
      'https://bs.example/api/cloud-agents/me/github/callback',
    );
  });

  it('takes tiers from app-config and rejects a bad key or harness', () => {
    const env = {
      CLOUD_AGENTS_RUNNER_IMAGE: 'img',
      CLOUD_AGENTS_ENCRYPTION_KEY: key.toString('base64'),
    };
    const cfg = readCloudAgentsConfig(
      new ConfigReader({
        ...base,
        cloudAgents: { tiers: { fast: { harness: 'claude', model: 'm' } } },
      }),
      env,
    );
    expect([...cfg.tiers.values()]).toEqual([
      { name: 'fast', harness: 'claude', model: 'm', effort: 'high' },
    ]);
    expect(() =>
      readCloudAgentsConfig(
        new ConfigReader({
          ...base,
          cloudAgents: { tiers: { x: { harness: 'vim', model: 'm' } } },
        }),
        env,
      ),
    ).toThrow(/harness/);
    expect(() =>
      readCloudAgentsConfig(new ConfigReader(base), {
        ...env,
        CLOUD_AGENTS_ENCRYPTION_KEY: 'c2hvcnQ=',
      }),
    ).toThrow(/32 bytes/);
    expect(() =>
      readCloudAgentsConfig(new ConfigReader(base), {
        CLOUD_AGENTS_ENCRYPTION_KEY: key.toString('base64'),
      }),
    ).toThrow(/runnerImage/);
  });
});

describe('job spec', () => {
  const spec = {
    namespace: 'ns',
    runnerImage: 'img',
    job: {
      activeDeadlineSeconds: 60,
      ttlSecondsAfterFinished: 30,
      serviceAccountName: undefined,
      imagePullSecrets: [],
      nodeSelector: undefined,
      resources: { requests: {}, limits: {} },
    },
  };
  const launch: RunLaunch = {
    agentId: 'ag_0123456789ab',
    runId: 'run-1',
    jobName: jobNameFor('ag_0123456789ab', 2),
    harness: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    repo: 'a/b',
    base: 'main',
    branch: 'cloud-agent/x',
    prompt: 'brief',
    credentials: { env: { GH_TOKEN: 'gh' }, codexAuthJson: '{"tokens":{}}' },
  };

  it('mounts a ChatGPT auth.json as a file and passes only Secret refs as env', () => {
    expect(launch.jobName).toBe('cloud-agent-0123456789ab-2');
    const job = buildJob(spec, launch);
    const container = job.spec!.template.spec!.containers[0]!;
    expect(job.spec!.suspend).toBe(true);
    expect(container.env).toEqual([
      { name: 'CLOUD_AGENT_RUN_ID', value: 'run-1' },
      {
        name: 'GH_TOKEN',
        valueFrom: { secretKeyRef: { name: launch.jobName, key: 'GH_TOKEN' } },
      },
      {
        name: 'CODEX_AUTH_JSON',
        value: '/var/run/cloud-agent/codex/auth.json',
      },
    ]);
    expect(JSON.stringify(job)).not.toContain('tokens');
    const secret = buildSecret(spec, launch, {
      name: launch.jobName,
      uid: 'u',
    });
    expect(Object.keys(secret.stringData!).sort()).toEqual([
      'GH_TOKEN',
      'codex-auth.json',
      'prompt.md',
    ]);
  });
});

describe('outcomeOfExitCode', () => {
  it('maps the runner exit codes', () => {
    expect(
      [0, 1, 3, 130, 137].map(c => outcomeOfExitCode(c, false).status),
    ).toEqual(['succeeded', 'failed', 'needs_input', 'stopped', 'failed']);
    expect(outcomeOfExitCode(1, true).status).toBe('stopped');
  });
});
