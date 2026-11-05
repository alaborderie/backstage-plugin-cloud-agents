# backstage-plugin-cloud-agents

A Backstage plugin that runs coding agents (Claude Code, Codex, or OpenCode) as Kubernetes Jobs and shows their work live. A user starts an agent on a GitHub repository from Backstage or from an external client such as T3 Code. Each run is one Job of the [cloud-agent-runner](runner/README.md) image. The plugin stores each event the runner prints, streams it over Server-Sent Events, and shows the agent's pull request when the run ends.

The repository holds two products:

- `plugins/`: the npm packages of two plugins, cloud agents and the assistant, that any Backstage on the new backend system can add.
- `runner/`: the `ghcr.io/alaborderie/cloud-agent-runner` image and its event format ([runner/EVENTS.md](runner/EVENTS.md)). It has its own README and CI.

| Package                                    | Directory                      | What it is                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@alaborderie/plugin-cloud-agents-backend` | `plugins/cloud-agents-backend` | The backend plugin: the API at `/api/cloud-agents`, the database tables, the Job launcher, and the log follower.                                                                                      |
| `@alaborderie/plugin-cloud-agents`         | `plugins/cloud-agents`         | The frontend plugin, built on Backstage UI: the agents list, an agent's live timeline and questions, the new agent form, the settings page for credentials and access tokens, and a home page widget. |
| `@alaborderie/plugin-cloud-agents-common`  | `plugins/cloud-agents-common`  | TypeScript types of the API and of the runner events.                                                                                                                                                 |
| `@alaborderie/plugin-assistant-backend`    | `plugins/assistant-backend`    | The assistant's backend: conversations at `/api/assistant`, each turn streamed from a fast chat model with tools over the catalog, TechDocs, GitHub, and the cloud-agents actions.                    |
| `@alaborderie/plugin-assistant`            | `plugins/assistant`            | The assistant's page at `/assistant`: the conversations, the streamed answers, and a live card for each agent the chat launches, then its summary.                                                    |
| `@alaborderie/plugin-assistant-common`     | `plugins/assistant-common`     | TypeScript types of the assistant API.                                                                                                                                                                |

[docs/API.md](docs/API.md) is the API contract, version 1. [docs/ASSISTANT.md](docs/ASSISTANT.md) describes the assistant.

## The assistant

The assistant is a chat at `/assistant`. Each turn streams from a fast model without reasoning, DeepSeek V4.1 Flash through OpenCode Go by default, with one key for the whole Backstage. The model answers catalog questions from a catalog index in its prompt, and calls tools for the rest: catalog search, TechDocs, read-only GitHub, and the state of the user's cloud agents. For a hard question it calls Claude Opus 5.5 through Claude Code with the user's own Claude Code credential, the one their agent runs use, or with an Anthropic API key when they have none. Both live in Cloud agents settings. For work in a repository it starts a cloud agent or a hub through the `cloud-agents:*` actions, as the user. The page follows the agent live in a card, and when the agent finishes, writes its summary into the conversation. Conversations are stored per user.

To add it, add `@alaborderie/plugin-assistant-backend` to the backend and `@alaborderie/plugin-assistant` to the app as for cloud agents, keep `backend.actions.pluginSources: [cloud-agents]`, and set `ASSISTANT_OPENCODE_GO_API_KEY` (or `assistant.chatModel.apiKey`). [docs/ASSISTANT.md](docs/ASSISTANT.md) has the configuration.

## How a run works

1. `POST /agents` resolves the tier (or the given harness and model), checks that the user has the harness credential and a GitHub credential, and stores the agent and its first run.
2. The plugin creates a suspended Job in `CLOUD_AGENTS_NAMESPACE`, then a Secret that the Job owns, then resumes the Job. The Secret holds the prompt, `GH_TOKEN`, the run's credential token (`CLOUD_AGENT_RUN_TOKEN`), and only the credential of the run's harness. Kubernetes deletes the Secret with the Job.
3. A follower reads the pod log, validates each line against `events.v1.schema.json`, and stores it with an agent-wide `seq`. Lines that are not events, such as the runner's stderr, are skipped.
4. `GET /agents/:id/events` replays the stored events after `Last-Event-ID` (or `?after=`), then sends live ones. It closes after the agent reaches `succeeded`, `failed`, or `stopped`.
5. `run.finished` sets the run and agent status and the agent's `prUrl`. A blocking question ends the run as `needs_input`. `POST /agents/:id/reply` with the last answer starts the next run on the same branch, with the original prompt, the questions, and the answers.

### Hubs

An agent of kind `hub` takes an objective and works through child agents. Each hub run reads the `backstage-hub` skill, starts or follows children with the hub tools of the runner's `cloud_agent` MCP server, and exits. While children work, the hub is `waiting` and has no pod. When a child succeeds, fails, stops, or asks a question, the plugin starts the next hub run, with reason `child`, and lists the events in the run's prompt. The hub finishes once its last run ends with every child finished. The hub tools call the `cloud-agents:*` actions with the run's token, which reaches only that hub's children. [docs/API.md](docs/API.md#additions-hubs-children-and-actions-contract-for-hub-2026-11-05-cloud-agents-delegation) has the contract.

When Backstage restarts, the plugin follows every run the database still lists as running. It reads each pod log from the start and skips the runner seqs it already stored, so no event is stored twice or lost while the pod exists. If the pod disappears without `run.finished`, the run fails, or stops when the user asked for a stop.

## Add the plugin to a Backstage app

These steps assume the new backend system and the new frontend system, as in a Backstage app created in 2025 or later.

1. Add the packages:

   ```sh
   yarn --cwd packages/backend add @alaborderie/plugin-cloud-agents-backend
   yarn --cwd packages/app add @alaborderie/plugin-cloud-agents
   ```

2. Register the backend plugin in `packages/backend/src/index.ts`:

   ```ts
   backend.add(import('@alaborderie/plugin-cloud-agents-backend'));
   ```

   For hubs, also add the token handler of hub runs, and let it and the actions registry reach the plugin in `app-config.yaml`:

   ```ts
   import { cloudAgentsHubRunTokens } from '@alaborderie/plugin-cloud-agents-backend';
   backend.add(cloudAgentsHubRunTokens);
   ```

   ```yaml
   backend:
     auth:
       externalAccess:
         - type: cloud-agents-hub-run
           options: {}
           accessRestrictions:
             - plugin: cloud-agents
     actions:
       pluginSources: [cloud-agents]
   ```

   `backend.actions.pluginSources` also exposes the six `cloud-agents:*` actions to `@backstage/plugin-mcp-actions-backend` and to other plugins through `actionsServiceRef`.

3. With `app.packages: all` in `app-config.yaml`, the frontend discovers the plugin. Otherwise add it to `createApp({ features: [...] })`:

   ```ts
   import cloudAgentsPlugin from '@alaborderie/plugin-cloud-agents';
   ```

   The plugin adds the page `/cloud-agents`, a nav item, and the home page widget `home-page-widget:cloud-agents/cloud-agents`, which `@backstage/plugin-home` picks up when the app has it. `@alaborderie/plugin-cloud-agents/alpha` also exports the widget as `cloudAgentsHomeWidget`. On the legacy frontend system, mount `<CloudAgentsPage />` at `/cloud-agents` and add `legacyCloudAgentsPlugin` to the app's plugins.

   The UI reads only Backstage UI (BUI) CSS variables, so it follows the app's theme. The app must load `@backstage/ui/css/styles.css`, as apps created from the current template do. Tertiary text reads `--ember-fg-tertiary` and falls back to `--bui-fg-secondary`.

   Other pages can link to `/cloud-agents/new?repo=<owner>/<name>&issue=<number>&title=<issue title>`. The form opens with that repository, the title, and a prompt that points at the issue.
   Repository links can omit `issue` and supply optional `title` and `prompt`, such as `/cloud-agents/new?repo=alaborderie/keyroll&title=T&prompt=P`. Catalog entities with `github.com/project-slug` get a visible **New agent** action on their overview in the new frontend system. It prefills repository and entity context and leaves the task for you to write. See the [frontend README](plugins/cloud-agents/README.md) for parameters and the Ember preview routes.

4. Set the configuration below, create the namespace and the RBAC, and register the GitHub App callback.

## Configure it

The plugin reads app-config first and falls back to the environment variable in the second column.

| app-config key                            | Environment variable              | Default                                                           | Meaning                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | --------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudAgents.namespace`                   | `CLOUD_AGENTS_NAMESPACE`          | `cloud-agents`                                                    | The namespace for agent Jobs and Secrets.                                                                                                                                                                                                                                                 |
| `cloudAgents.runnerImage`                 | `CLOUD_AGENTS_RUNNER_IMAGE`       | required                                                          | The runner image, for example `ghcr.io/alaborderie/cloud-agent-runner:sha-de01b1b`.                                                                                                                                                                                                       |
| `cloudAgents.encryptionKey`               | `CLOUD_AGENTS_ENCRYPTION_KEY`     | required                                                          | Base64 of 32 random bytes (`openssl rand -base64 32`). The AES-256-GCM key for stored credentials. Changing it makes stored credentials unreadable.                                                                                                                                       |
| `cloudAgents.github.clientId`             | `AUTH_GITHUB_CLIENT_ID`           | none                                                              | The GitHub App's client ID for `/me/github/connect`. Without the ID and secret, users paste a token instead.                                                                                                                                                                              |
| `cloudAgents.github.clientSecret`         | `AUTH_GITHUB_CLIENT_SECRET`       | none                                                              | The GitHub App's client secret.                                                                                                                                                                                                                                                           |
| `cloudAgents.github.webBaseUrl`           |                                   | `https://github.com`                                              | For GitHub Enterprise Server.                                                                                                                                                                                                                                                             |
| `cloudAgents.github.apiBaseUrl`           |                                   | `https://api.github.com`                                          | For GitHub Enterprise Server.                                                                                                                                                                                                                                                             |
| `cloudAgents.runnerBackendUrl`            | `CLOUD_AGENTS_RUNNER_BACKEND_URL` | none                                                              | Backstage as runner pods reach it inside the cluster, for example `http://backstage.default.svc.cluster.local`. Pods then fetch the run's current GitHub token from it. See [GitHub tokens during a run](#github-tokens-during-a-run). Hubs need it: their pods call the hub tools there. |
| `cloudAgents.hubWakeDelayMs`              |                                   | `5000`                                                            | How long a child's event waits for others before it starts the waiting hub's next run, in ms.                                                                                                                                                                                             |
| `cloudAgents.tiers.<name>`                |                                   | see below                                                         | `{harness, model, effort}` presets for `POST /agents` `tier`. The frontend reads them too.                                                                                                                                                                                                |
| `cloudAgents.job.activeDeadlineSeconds`   |                                   | `14400`                                                           | The Job's time limit.                                                                                                                                                                                                                                                                     |
| `cloudAgents.job.ttlSecondsAfterFinished` |                                   | `3600`                                                            | How long Kubernetes keeps a finished Job and its pod.                                                                                                                                                                                                                                     |
| `cloudAgents.job.resources`               |                                   | requests `cpu: 500m, memory: 512Mi`, limits `cpu: 1, memory: 2Gi` | The runner container's resources.                                                                                                                                                                                                                                                         |
| `cloudAgents.job.serviceAccountName`      |                                   | none                                                              | The pod's ServiceAccount. Without one, the pod gets no API token.                                                                                                                                                                                                                         |
| `cloudAgents.job.imagePullSecrets`        |                                   | `[]`                                                              | Pull secrets for a private runner image.                                                                                                                                                                                                                                                  |
| `cloudAgents.job.nodeSelector`            |                                   | none                                                              | A node selector for agent pods.                                                                                                                                                                                                                                                           |
| `cloudAgents.podStartTimeoutMs`           |                                   | `120000`                                                          | Maximum wait for a runner container to start.                                                                                                                                                                                                                                             |
| `cloudAgents.pollIntervalMs`              |                                   | `2000`                                                            | How often a follower checks a pending pod.                                                                                                                                                                                                                                                |

The plugin also reads `app.baseUrl` (the GitHub callback returns the browser to `<app.baseUrl>/cloud-agents/settings`) and `backend.baseUrl` (the callback URL). It uses the Backstage database service, so it gets its own database or schema in the app's Postgres, and its migrations run at startup.

Without `cloudAgents.tiers`, the tiers are:

```yaml
cloudAgents:
  tiers:
    flash:
      {
        harness: opencode,
        model: opencode-go/deepseek-v4.1-flash,
        effort: high,
      }
    sol: { harness: codex, model: gpt-6.1-sol, effort: high }
    opus: { harness: claude, model: claude-opus-5-5, effort: high }
```

## Kubernetes requirements

The agents namespace and Backstage's ServiceAccount must already exist. The plugin loads `KUBECONFIG`, then `~/.kube/config`, then the in-cluster ServiceAccount. Save the following as `cloud-agents-rbac.yaml` and run `kubectl apply -f cloud-agents-rbac.yaml`. Change the namespace and subject to match your installation. This grants the exact operations in `plugins/cloud-agents-backend/src/kube.ts`.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: backstage-cloud-agents
  namespace: cloud-agents
rules:
  - apiGroups: [batch]
    resources: [jobs]
    verbs: [create, get, patch, delete]
  - apiGroups: ['']
    resources: [pods]
    verbs: [list]
  - apiGroups: ['']
    resources: [pods/log]
    verbs: [get]
  - apiGroups: ['']
    resources: [events]
    verbs: [list]
  - apiGroups: ['']
    resources: [secrets]
    verbs: [create]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: backstage-cloud-agents
  namespace: cloud-agents
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: backstage-cloud-agents
subjects:
  - kind: ServiceAccount
    name: backstage
    namespace: backstage
```

`patch jobs` resumes the suspended Job after the per-run Secret exists. The Job controller creates pods. Kubernetes garbage-collects owned Secrets. The backend does not need permissions to create pods or read or delete Secrets. `list events` reads `FailedCreate` admission failures for a Job. Following logs uses `get pods/log`, without a `watch` verb.

Each runner container defaults to these resources:

```yaml
cloudAgents:
  job:
    resources:
      requests:
        cpu: '500m'
        memory: '512Mi'
      limits:
        cpu: '1'
        memory: '2Gi'
```

Override these values in your app-config. Each nonempty `requests` or `limits` map replaces that entire default map, so set both CPU and memory when you need both. Backstage's config loader also accepts the same values through `APP_CONFIG_` environment variables. Quote each quantity as a JSON string so CPU `1` remains a string:

```sh
export APP_CONFIG_cloudAgents_job_resources_requests_cpu='"500m"'
export APP_CONFIG_cloudAgents_job_resources_requests_memory='"512Mi"'
export APP_CONFIG_cloudAgents_job_resources_limits_cpu='"1"'
export APP_CONFIG_cloudAgents_job_resources_limits_memory='"2Gi"'
```

The namespace's LimitRange and ResourceQuota must admit these requests and limits, including the aggregate resources of concurrent runs. A quota on Jobs or Secrets must also leave room for each run. Defaults cannot satisfy every cluster's policy. Adjust the resources or the namespace policy before starting agents.

A Kubernetes refusal fails the run and includes the operation, namespace, and API rejection in its `agent.status` event. Job `FailedCreate` events include the admission message, such as a LimitRange or quota violation. If no pod appears or the runner container stays pending for `cloudAgents.podStartTimeoutMs` (default 120000), the run fails with the latest pod waiting or scheduler message when available. The plugin deletes the Job on startup failure so a queued pod cannot start later. Increase this timeout for slow image pulls or scheduling. The follower retries transient API outages and rate limits.

### Verify with the restricted Role

Use a local test cluster. With its administrator kubeconfig selected, create the namespaces and ServiceAccount once:

```sh
kubectl create namespace cloud-agents
kubectl create namespace backstage
kubectl -n backstage create serviceaccount backstage
kubectl apply -f cloud-agents-rbac.yaml
node plugins/.claude/skills/verify-cloud-agents-plugin/scripts/service-account-kubeconfig.mjs /tmp/cloud-agents-sa.json
export KUBECONFIG=/tmp/cloud-agents-sa.json
```

The helper reads only the administrator's cluster connection and requests a one-hour token for `backstage/backstage`. It writes a new kubeconfig with only that token and file mode `0600`. It never changes your administrator kubeconfig. Run it again with a new output path when the token expires.

Start the dev backend with this `KUBECONFIG` using step 3 in [Develop](#develop). In the e2e shell, select the same file and run:

```sh
export KUBECONFIG=/tmp/cloud-agents-sa.json
VERIFY_KUBE_RBAC=1 plugins/.claude/skills/verify-cloud-agents-plugin/scripts/e2e.sh /tmp/plugin-e2e
```

This mode uses [`kubectl auth can-i`](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_auth/kubectl_auth_can-i/) to check each permission in the Role and rejects broader permissions to list Jobs or read Secrets before launching an agent. The backend restart check inherits the same kubeconfig. The initial backend must also use this file. Keep administrator-only setup and cleanup in a separate shell.

## Connect GitHub through a GitHub App

Users can paste a GitHub token on the settings page. To offer **Connect with GitHub** instead, use a GitHub App with "Expire user authorization tokens" on:

1. Add `<backend.baseUrl>/api/cloud-agents/me/github/callback` to the App's callback URLs. An App can list several, so the App that signs users in to Backstage works too.
2. Give the App the repository permissions an agent needs: Contents and Pull requests (read and write), and Metadata (read). Install it on the repositories agents work on.
3. Set `cloudAgents.github.clientId` and `clientSecret`, or `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET`.

A user token from the App lasts 8 hours. The plugin stores the refresh token. Runs push and open pull requests as the user.

### GitHub tokens during a run

GitHub invalidates a user token when the plugin refreshes it, and every run of the user holds that token. So the plugin refreshes it rarely, and pods ask for the current one:

- At a run start, the plugin refreshes the token only when it expires within `cloudAgents.job.activeDeadlineSeconds` plus 10 minutes, or when GitHub answers `401` to it. Otherwise the run gets the stored token.
- Refreshes of one user run one at a time, under a lock on the user's `github` credential row. Concurrent run starts wait for the first refresh and reuse its token.
- With `cloudAgents.runnerBackendUrl` set, each pod gets `CLOUD_AGENT_GH_TOKEN_URL`, and git and `gh` in the pod ask that URL for the current token each time they run. The plugin refreshes the token there when it expires within 10 minutes. A run that started before a refresh, or that outlasts the token, keeps working.
- The pod authenticates with its run's credential token, `CLOUD_AGENT_RUN_TOKEN` in its Secret. The plugin stores only its SHA-256 hash, accepts it only while the run is active, and never logs it. See [docs/API.md](docs/API.md#additions-runner-credential-endpoint).

Without `cloudAgents.runnerBackendUrl`, pods use the `GH_TOKEN` they started with. A refresh then breaks the runs that hold the old token, which happens only when the token is about to expire.

The pod reaches Backstage through its Service, so a NetworkPolicy in `CLOUD_AGENTS_NAMESPACE` must allow egress to it. In production, `http://backstage.default.svc.cluster.local` is the Service on port 80, which forwards to the backend's port 7007.

The runner also clones the private skills repository `alaborderie/claude-plugins` with `GH_TOKEN` (see [runner/README.md](runner/README.md#skills)). For another organization, build the runner with a skills repository its users can read.

## Credentials and tokens

Each user sets their own credentials on **Cloud agents > Settings**, or with `PUT /me/credentials/:name`:

| Credential | Value                                                                              | The run gets                                                   |
| ---------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `claude`   | The token from `claude setup-token`.                                               | `CLAUDE_CODE_OAUTH_TOKEN`                                      |
| `codex`    | An OpenAI API key (`kind: api_key`), or a ChatGPT `auth.json` (`kind: auth_json`). | `CODEX_API_KEY`, or the file `auth.json` and `CODEX_AUTH_JSON` |
| `opencode` | An OpenCode Go API key.                                                            | `OPENCODE_API_KEY`                                             |
| `github`   | The GitHub App connection, or a token.                                             | `GH_TOKEN`                                                     |

The plugin seals each value with AES-256-GCM. The additional data is the user's entity ref and the credential name, so a sealed value copied to another user or credential does not decrypt. No route returns a value, except that a runner pod gets its run's GitHub token from `GET /runner/github-token`. The plugin logs only credential names. A run's Secret holds `GH_TOKEN`, `CLOUD_AGENT_RUN_TOKEN`, and the credential of its harness, nothing else. The runner redacts these values from its output (see [runner/EVENTS.md](runner/EVENTS.md#credentials)).

External clients authenticate with a personal access token: `Authorization: Bearer cat_...`. A user creates one on the settings page or with `POST /me/tokens`, and sees it once. The plugin stores its SHA-256 hash and resolves it to the user who created it. A token acts as that user on every route.

## Develop

You need Node 22 or 24, Corepack, Docker, [kind](https://kind.sigs.k8s.io/), and `kubectl`.

1. Install the dependencies:

   ```sh
   corepack enable
   yarn install
   ```

2. Create a cluster and the namespace. A separate kubeconfig file keeps your current kubectl context unchanged:

   ```sh
   kind create cluster --name cloud-agents --kubeconfig ~/.kube/kind-cloud-agents
   export KUBECONFIG=~/.kube/kind-cloud-agents
   kubectl create namespace cloud-agents
   ```

3. Start the dev backend. It runs the plugin, the auth plugin with the guest provider, and SQLite files in `plugins/cloud-agents-backend/.sqlite/`:

   ```sh
   export CLOUD_AGENTS_RUNNER_IMAGE=ghcr.io/alaborderie/cloud-agent-runner:sha-de01b1b
   export CLOUD_AGENTS_ENCRYPTION_KEY="$(openssl rand -base64 32)"
   yarn start:backend
   ```

   It is ready when `curl -sf http://localhost:7007/.backstage/health/v1/readiness` succeeds. Keep the same encryption key across restarts, or the stored credentials stop decrypting.

4. In another shell, start the dev app and open <http://localhost:3000/cloud-agents>. Sign in as guest:

   ```sh
   yarn start:frontend
   ```

   Add `?mock` to any page, such as <http://localhost:3000/cloud-agents?mock>, to use invented agents and a scripted live run instead of the backend; `?mock=0` switches back. The dev app previews the Ember theme's BUI variables (`plugins/cloud-agents/dev/ember-preview.css`). To run on other ports, set `APP_CONFIG_app_baseUrl` and `APP_CONFIG_backend_baseUrl` for both processes, and `APP_CONFIG_backend_listen_port` and `APP_CONFIG_backend_cors_origin` for the backend.

To call the API from a shell, get a Backstage token for the guest user, then create a `cat_` token with it:

```sh
guest=$(curl -s http://localhost:7007/api/auth/guest/refresh -H 'X-Requested-With: XMLHttpRequest' | jq -r .backstageIdentity.token)
curl -s -X POST http://localhost:7007/api/cloud-agents/me/tokens \
  -H "Authorization: Bearer $guest" -H 'Content-Type: application/json' -d '{"name":"cli"}'
```

`plugins/.claude/skills/verify-cloud-agents-plugin/` drives the whole flow against the dev setup: credentials and tokens through the API, one real OpenCode agent on the sandbox repository, the event stream with a reconnect and a Backstage restart, the browser UI, and a search for leaked credential values.

### Check a change

```sh
yarn tsc
yarn lint
yarn prettier:check
yarn test
yarn build
```

`yarn test` runs the backend tests on SQLite and, when Docker is available, on Postgres 16. The integration tests start the plugin against a fake Kubernetes API that plays the recorded runner streams in `runner/test/streams/`.

### Release

`.github/workflows/plugins.yml` runs the checks on every pull request that touches the plugins. On `main`, it publishes the three packages to npm when the repository has an `NPM_TOKEN` secret, and skips publishing when it does not. It publishes each package whose version npm does not have yet, so bump the versions in the three `package.json` files to release.
