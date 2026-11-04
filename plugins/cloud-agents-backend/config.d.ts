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
    /** How often a follower checks a pending pod, in ms. Default 2000. */
    pollIntervalMs?: number;
    /** Settings for each agent's Kubernetes Job. */
    job?: {
      /** Default 14400 (4 hours). */
      activeDeadlineSeconds?: number;
      /** Default 3600. */
      ttlSecondsAfterFinished?: number;
      serviceAccountName?: string;
      imagePullSecrets?: string[];
      nodeSelector?: { [key: string]: string };
      resources?: {
        requests?: { cpu?: string; memory?: string };
        limits?: { cpu?: string; memory?: string };
      };
    };
  };
}
