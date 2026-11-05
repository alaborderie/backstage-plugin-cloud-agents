import type { V1Job, V1Secret } from '@kubernetes/client-node';
import type {
  AgentKind,
  Harness,
} from '@alaborderie/plugin-cloud-agents-common';
import type { JobConfig } from './config';
import type { RunCredentials } from './credentials';

export const CONTAINER_NAME = 'runner';
export const LABEL_MANAGED_BY = 'app.kubernetes.io/managed-by';
export const MANAGED_BY = 'backstage-plugin-cloud-agents';
export const LABEL_AGENT_ID = 'cloud-agents/agent-id';
export const LABEL_RUN_ID = 'cloud-agents/run-id';
/** The Secret key and env var of the token a pod sends to fetch its GitHub token. */
export const RUN_TOKEN_ENV = 'CLOUD_AGENT_RUN_TOKEN';
/** On a hub run, `hub`: the runner then offers the hub tools. */
export const KIND_ENV = 'CLOUD_AGENT_KIND';
/** The plugin's API as the pod reaches it, for the hub tools. */
export const API_URL_ENV = 'CLOUD_AGENT_API_URL';

const PROMPT_DIR = '/var/run/cloud-agent/prompt';
const CODEX_DIR = '/var/run/cloud-agent/codex';
const PROMPT_KEY = 'prompt.md';
const CODEX_AUTH_KEY = 'codex-auth.json';
const RUNNER_UID = 10001;

/** One run's Job, as the launcher needs it. */
export interface RunLaunch {
  agentId: string;
  kind: AgentKind;
  runId: string;
  jobName: string;
  harness: Harness;
  model: string;
  effort: string;
  repo: string;
  base: string;
  branch: string;
  prompt: string;
  credentials: RunCredentials;
}

export interface JobSpecConfig {
  namespace: string;
  runnerImage: string;
  job: JobConfig;
  runnerGithubTokenUrl: string | undefined;
  runnerApiUrl: string | undefined;
}

/** `ag_3f9c…` and run 2 give `cloud-agent-3f9c…-2`, a valid DNS-1123 name. */
export function jobNameFor(agentId: string, ordinal: number): string {
  return `cloud-agent-${agentId.replace(/^ag_/, '')}-${ordinal}`;
}

function labels(launch: RunLaunch): Record<string, string> {
  return {
    [LABEL_MANAGED_BY]: MANAGED_BY,
    [LABEL_AGENT_ID]: launch.agentId,
    [LABEL_RUN_ID]: launch.runId,
  };
}

/**
 * The Job starts suspended. The launcher creates the Secret owned by the Job,
 * then resumes it, so the pod never starts without its Secret.
 */
export function buildJob(cfg: JobSpecConfig, launch: RunLaunch): V1Job {
  const secretEnv = Object.keys(launch.credentials.env).sort();
  const hasCodexFile = launch.credentials.codexAuthJson !== undefined;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: launch.jobName,
      namespace: cfg.namespace,
      labels: labels(launch),
    },
    spec: {
      suspend: true,
      backoffLimit: 0,
      activeDeadlineSeconds: cfg.job.activeDeadlineSeconds,
      ttlSecondsAfterFinished: cfg.job.ttlSecondsAfterFinished,
      template: {
        metadata: { labels: labels(launch) },
        spec: {
          restartPolicy: 'Never',
          ...(cfg.job.serviceAccountName
            ? { serviceAccountName: cfg.job.serviceAccountName }
            : { automountServiceAccountToken: false }),
          ...(cfg.job.nodeSelector
            ? { nodeSelector: cfg.job.nodeSelector }
            : {}),
          imagePullSecrets: cfg.job.imagePullSecrets.map(name => ({ name })),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: RUNNER_UID,
            runAsGroup: RUNNER_UID,
            fsGroup: RUNNER_UID,
          },
          containers: [
            {
              name: CONTAINER_NAME,
              image: cfg.runnerImage,
              args: [
                'run',
                '--harness',
                launch.harness,
                '--model',
                launch.model,
                '--effort',
                launch.effort,
                '--repo',
                launch.repo,
                '--base',
                launch.base,
                '--branch',
                launch.branch,
                '--prompt-file',
                `${PROMPT_DIR}/${PROMPT_KEY}`,
              ],
              env: [
                { name: 'CLOUD_AGENT_RUN_ID', value: launch.runId },
                ...(cfg.runnerGithubTokenUrl
                  ? [
                      {
                        name: 'CLOUD_AGENT_GH_TOKEN_URL',
                        value: cfg.runnerGithubTokenUrl,
                      },
                    ]
                  : []),
                ...(launch.kind === 'hub' && cfg.runnerApiUrl
                  ? [
                      { name: KIND_ENV, value: 'hub' },
                      { name: API_URL_ENV, value: cfg.runnerApiUrl },
                    ]
                  : []),
                ...secretEnv.map(name => ({
                  name,
                  valueFrom: {
                    secretKeyRef: { name: launch.jobName, key: name },
                  },
                })),
                ...(hasCodexFile
                  ? [
                      {
                        name: 'CODEX_AUTH_JSON',
                        value: `${CODEX_DIR}/auth.json`,
                      },
                    ]
                  : []),
              ],
              resources: cfg.job.resources,
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'prompt', mountPath: PROMPT_DIR, readOnly: true },
                ...(hasCodexFile
                  ? [{ name: 'codex', mountPath: CODEX_DIR, readOnly: true }]
                  : []),
              ],
            },
          ],
          volumes: [
            {
              name: 'prompt',
              secret: {
                secretName: launch.jobName,
                items: [{ key: PROMPT_KEY, path: PROMPT_KEY }],
                defaultMode: 0o444,
              },
            },
            ...(hasCodexFile
              ? [
                  {
                    name: 'codex',
                    secret: {
                      secretName: launch.jobName,
                      items: [{ key: CODEX_AUTH_KEY, path: 'auth.json' }],
                      defaultMode: 0o444,
                    },
                  },
                ]
              : []),
          ],
        },
      },
    },
  };
}

/** The run's Secret, deleted with the Job through its owner reference. */
export function buildSecret(
  cfg: JobSpecConfig,
  launch: RunLaunch,
  job: { name: string; uid: string },
): V1Secret {
  const stringData: Record<string, string> = {
    ...launch.credentials.env,
    [PROMPT_KEY]: launch.prompt,
  };
  if (launch.credentials.codexAuthJson !== undefined) {
    stringData[CODEX_AUTH_KEY] = launch.credentials.codexAuthJson;
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: launch.jobName,
      namespace: cfg.namespace,
      labels: labels(launch),
      ownerReferences: [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          name: job.name,
          uid: job.uid,
          controller: true,
        },
      ],
    },
    stringData,
  };
}
