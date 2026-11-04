import type { Config } from '@backstage/config';
import {
  DEFAULT_TIERS,
  HARNESSES,
  type Harness,
  type TierInfo,
} from '@alaborderie/plugin-cloud-agents-common';

export interface GithubAppConfig {
  clientId: string;
  clientSecret: string;
  webBaseUrl: string;
  apiBaseUrl: string;
}

export interface JobConfig {
  activeDeadlineSeconds: number;
  ttlSecondsAfterFinished: number;
  serviceAccountName: string | undefined;
  imagePullSecrets: string[];
  nodeSelector: Record<string, string> | undefined;
  resources: {
    requests: Record<string, string>;
    limits: Record<string, string>;
  };
}

/** Everything the plugin reads from app-config and env, parsed once at startup. */
export interface CloudAgentsConfig {
  namespace: string;
  runnerImage: string;
  encryptionKey: Buffer;
  tiers: Map<string, TierInfo>;
  /** `undefined` when no GitHub App is configured; only tokens can be set then. */
  githubApp: GithubAppConfig | undefined;
  githubApiBaseUrl: string;
  job: JobConfig;
  /** Where the GitHub callback sends the browser back to. */
  settingsPageUrl: string;
  /** The callback URL registered on the GitHub App. */
  githubCallbackUrl: string;
}

type Env = Record<string, string | undefined>;

function readString(
  config: Config,
  key: string,
  env: Env,
  envName: string,
): string | undefined {
  return config.getOptionalString(key) || env[envName] || undefined;
}

function parseHarness(value: string, where: string): Harness {
  if (!(HARNESSES as readonly string[]).includes(value)) {
    throw new Error(
      `${where}: harness must be one of ${HARNESSES.join(
        ', ',
      )}, got '${value}'`,
    );
  }
  return value as Harness;
}

function readTiers(config: Config): Map<string, TierInfo> {
  const tiersConfig = config.getOptionalConfig('cloudAgents.tiers');
  if (!tiersConfig) {
    return new Map(DEFAULT_TIERS.map(t => [t.name, t]));
  }
  const tiers = new Map<string, TierInfo>();
  for (const name of tiersConfig.keys()) {
    const tier = tiersConfig.getConfig(name);
    tiers.set(name, {
      name,
      harness: parseHarness(
        tier.getString('harness'),
        `cloudAgents.tiers.${name}`,
      ),
      model: tier.getString('model'),
      effort: tier.getOptionalString('effort') ?? 'high',
    });
  }
  return tiers;
}

function readResources(config: Config | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['cpu', 'memory']) {
    const value = config?.getOptionalString(key);
    if (value) out[key] = value;
  }
  return out;
}

function readJob(config: Config): JobConfig {
  const job = config.getOptionalConfig('cloudAgents.job');
  const resources = job?.getOptionalConfig('resources');
  const requests = readResources(resources?.getOptionalConfig('requests'));
  const limits = readResources(resources?.getOptionalConfig('limits'));
  return {
    activeDeadlineSeconds:
      job?.getOptionalNumber('activeDeadlineSeconds') ?? 4 * 3600,
    ttlSecondsAfterFinished:
      job?.getOptionalNumber('ttlSecondsAfterFinished') ?? 3600,
    serviceAccountName: job?.getOptionalString('serviceAccountName'),
    imagePullSecrets: job?.getOptionalStringArray('imagePullSecrets') ?? [],
    nodeSelector: job?.getOptional<Record<string, string>>('nodeSelector'),
    resources: {
      requests: Object.keys(requests).length
        ? requests
        : { cpu: '500m', memory: '512Mi' },
      limits: Object.keys(limits).length ? limits : { cpu: '1', memory: '2Gi' },
    },
  };
}

export function parseEncryptionKey(value: string | undefined): Buffer {
  if (!value) {
    throw new Error(
      'cloudAgents.encryptionKey or env CLOUD_AGENTS_ENCRYPTION_KEY is required (base64 of 32 bytes)',
    );
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `The cloud-agents encryption key must be base64 of 32 bytes, got ${key.length} bytes`,
    );
  }
  return key;
}

export function readCloudAgentsConfig(
  config: Config,
  env: Env = process.env,
): CloudAgentsConfig {
  const runnerImage = readString(
    config,
    'cloudAgents.runnerImage',
    env,
    'CLOUD_AGENTS_RUNNER_IMAGE',
  );
  if (!runnerImage) {
    throw new Error(
      'cloudAgents.runnerImage or env CLOUD_AGENTS_RUNNER_IMAGE is required',
    );
  }
  const clientId = readString(
    config,
    'cloudAgents.github.clientId',
    env,
    'AUTH_GITHUB_CLIENT_ID',
  );
  const clientSecret = readString(
    config,
    'cloudAgents.github.clientSecret',
    env,
    'AUTH_GITHUB_CLIENT_SECRET',
  );
  const webBaseUrl =
    config.getOptionalString('cloudAgents.github.webBaseUrl') ??
    'https://github.com';
  const githubApiBaseUrl =
    config.getOptionalString('cloudAgents.github.apiBaseUrl') ??
    'https://api.github.com';
  const appBaseUrl = config.getString('app.baseUrl').replace(/\/$/, '');
  const backendBaseUrl = config.getString('backend.baseUrl').replace(/\/$/, '');

  return {
    namespace:
      readString(
        config,
        'cloudAgents.namespace',
        env,
        'CLOUD_AGENTS_NAMESPACE',
      ) ?? 'cloud-agents',
    runnerImage,
    encryptionKey: parseEncryptionKey(
      readString(
        config,
        'cloudAgents.encryptionKey',
        env,
        'CLOUD_AGENTS_ENCRYPTION_KEY',
      ),
    ),
    tiers: readTiers(config),
    githubApp:
      clientId && clientSecret
        ? { clientId, clientSecret, webBaseUrl, apiBaseUrl: githubApiBaseUrl }
        : undefined,
    githubApiBaseUrl,
    job: readJob(config),
    settingsPageUrl: `${appBaseUrl}/cloud-agents/settings`,
    githubCallbackUrl: `${backendBaseUrl}/api/cloud-agents/me/github/callback`,
  };
}
