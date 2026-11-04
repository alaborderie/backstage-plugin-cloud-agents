export interface Config {
  cloudAgents?: {
    /**
     * Namespace where agent Jobs and their Secrets run. Falls back to env
     * CLOUD_AGENTS_NAMESPACE, then `cloud-agents`.
     */
    namespace?: string;
    /**
     * The cloud-agent-runner image, for example
     * `ghcr.io/alaborderie/cloud-agent-runner:sha-de01b1b`. Falls back to env
     * CLOUD_AGENTS_RUNNER_IMAGE.
     */
    runnerImage?: string;
    /**
     * AES-256-GCM key for stored credentials, base64 of 32 bytes. Falls back to
     * env CLOUD_AGENTS_ENCRYPTION_KEY.
     * @visibility secret
     */
    encryptionKey?: string;
    /** GitHub App user authorization for `/me/github/connect`. */
    github?: {
      /** Falls back to env AUTH_GITHUB_CLIENT_ID. */
      clientId?: string;
      /**
       * Falls back to env AUTH_GITHUB_CLIENT_SECRET.
       * @visibility secret
       */
      clientSecret?: string;
      /** Default `https://github.com`. */
      webBaseUrl?: string;
      /** Default `https://api.github.com`. */
      apiBaseUrl?: string;
    };
    /**
     * The Backstage backend as runner pods reach it inside the cluster, for
     * example `http://backstage.default.svc.cluster.local`. Pods then fetch
     * the current GitHub token of their run from
     * `<runnerBackendUrl>/api/cloud-agents/runner/github-token`. Falls back to
     * env CLOUD_AGENTS_RUNNER_BACKEND_URL. Without it, a pod keeps the
     * `GH_TOKEN` it started with.
     */
    runnerBackendUrl?: string;
    /** How often a follower checks a pending pod, in ms. Default 2000. */
    pollIntervalMs?: number;
    /** Maximum wait for a runner container to start, in ms. Default 120000. */
    podStartTimeoutMs?: number;
    /** Settings for each agent's Kubernetes Job. */
    job?: {
      /** Default 14400 (4 hours). */
      activeDeadlineSeconds?: number;
      /** Default 3600. */
      ttlSecondsAfterFinished?: number;
      serviceAccountName?: string;
      imagePullSecrets?: string[];
      nodeSelector?: { [key: string]: string };
      /** Must be admitted by the namespace LimitRange and ResourceQuota. */
      resources?: {
        /** Defaults to cpu 500m, memory 512Mi. A configured map replaces it. */
        requests?: { cpu?: string; memory?: string };
        /** Defaults to cpu 1, memory 2Gi. A configured map replaces it. */
        limits?: { cpu?: string; memory?: string };
      };
    };
  };
}
