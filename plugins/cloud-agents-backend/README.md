# @alaborderie/plugin-cloud-agents-backend

The backend plugin of cloud agents. It serves the API in [docs/API.md](../../docs/API.md) at `/api/cloud-agents`, runs each agent run as a Kubernetes Job of the cloud-agent-runner image, and stores and streams the runner's events.

```ts
// packages/backend/src/index.ts
backend.add(import('@alaborderie/plugin-cloud-agents-backend'));
```

The [repository README](../../README.md) lists the configuration, the RBAC the plugin needs, and the GitHub App setup.
