# backstage-plugin-cloud-agents

A Backstage plugin that runs coding agents (Claude Code, Codex, or OpenCode) as Kubernetes Jobs and shows their work live. A user starts an agent on a GitHub repository from Backstage or from an external client such as T3 Code. Each run is one Job of the [cloud-agent-runner](runner/README.md) image. The plugin stores each event the runner prints, streams it over Server-Sent Events, and shows the agent's pull request when the run ends.

The repository holds two products:

- `plugins/`: three npm packages that any Backstage on the new backend system can add.
- `runner/`: the `ghcr.io/alaborderie/cloud-agent-runner` image and its event format ([runner/EVENTS.md](runner/EVENTS.md)). It has its own README and CI.

| Package                                    | Directory                      | What it is                                                                                                                                                 |
| ------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@alaborderie/plugin-cloud-agents-backend` | `plugins/cloud-agents-backend` | The backend plugin: the API at `/api/cloud-agents`, the database tables, the Job launcher, and the log follower.                                           |
| `@alaborderie/plugin-cloud-agents`         | `plugins/cloud-agents`         | The frontend plugin: the agents list, an agent's live timeline and questions, the new agent form, and the settings page for credentials and access tokens. |
| `@alaborderie/plugin-cloud-agents-common`  | `plugins/cloud-agents-common`  | TypeScript types of the API and of the runner events.                                                                                                      |

[docs/API.md](docs/API.md) is the API contract, version 1.

## How a run works

1. `POST /agents` resolves the tier (or the given harness and model), checks that the user has the harness credential and a GitHub credential, and stores the agent and its first run.
2. The plugin creates a suspended Job in `CLOUD_AGENTS_NAMESPACE`, then a Secret that the Job owns, then resumes the Job. The Secret holds the prompt, `GH_TOKEN`, and only the credential of the run's harness. Kubernetes deletes the Secret with the Job.
3. A follower reads the pod log, validates each line against `events.v1.schema.json`, and stores it with an agent-wide `seq`. Lines that are not events, such as the runner's stderr, are skipped.
4. `GET /agents/:id/events` replays the stored events after `Last-Event-ID` (or `?after=`), then sends live ones. It closes after the agent reaches `succeeded`, `failed`, or `stopped`.
5. `run.finished` sets the run and agent status and the agent's `prUrl`. A blocking question ends the run as `needs_input`. `POST /agents/:id/reply` with the last answer starts the next run on the same branch, with the original prompt, the questions, and the answers.

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

3. With `app.packages: all` in `app-config.yaml`, the frontend discovers the plugin. Otherwise add it to `createApp({ features: [...] })`:

   ```ts
   import cloudAgentsPlugin from '@alaborderie/plugin-cloud-agents';
   ```

   The plugin adds the page `/cloud-agents` and a nav item. On the legacy frontend system, mount `<CloudAgentsPage />` at `/cloud-agents` and add `legacyCloudAgentsPlugin` to the app's plugins.

4. Set the configuration below, create the namespace and the RBAC, and register the GitHub App callback.

## Configure it

The plugin reads app-config first and falls back to the environment variable in the second column.

| app-config key                            | Environment variable          | Default                                                 | Meaning                                                                                                                                             |
| ----------------------------------------- | ----------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudAgents.namespace`                   | `CLOUD_AGENTS_NAMESPACE`      | `cloud-agents`                                          | The namespace for agent Jobs and Secrets.                                                                                                           |
| `cloudAgents.runnerImage`                 | `CLOUD_AGENTS_RUNNER_IMAGE`   | required                                                | The runner image, for example `ghcr.io/alaborderie/cloud-agent-runner:sha-de01b1b`.                                                                 |
| `cloudAgents.encryptionKey`               | `CLOUD_AGENTS_ENCRYPTION_KEY` | required                                                | Base64 of 32 random bytes (`openssl rand -base64 32`). The AES-256-GCM key for stored credentials. Changing it makes stored credentials unreadable. |
| `cloudAgents.github.clientId`             | `AUTH_GITHUB_CLIENT_ID`       | none                                                    | The GitHub App's client ID for `/me/github/connect`. Without the ID and secret, users paste a token instead.                                        |
| `cloudAgents.github.clientSecret`         | `AUTH_GITHUB_CLIENT_SECRET`   | none                                                    | The GitHub App's client secret.                                                                                                                     |
| `cloudAgents.github.webBaseUrl`           |                               | `https://github.com`                                    | For GitHub Enterprise Server.                                                                                                                       |
| `cloudAgents.github.apiBaseUrl`           |                               | `https://api.github.com`                                | For GitHub Enterprise Server.                                                                                                                       |
| `cloudAgents.tiers.<name>`                |                               | see below                                               | `{harness, model, effort}` presets for `POST /agents` `tier`. The frontend reads them too.                                                          |
| `cloudAgents.job.activeDeadlineSeconds`   |                               | `14400`                                                 | The Job's time limit.                                                                                                                               |
| `cloudAgents.job.ttlSecondsAfterFinished` |                               | `3600`                                                  | How long Kubernetes keeps a finished Job and its pod.                                                                                               |
| `cloudAgents.job.resources`               |                               | requests `cpu: 500m, memory: 1Gi`, limits `memory: 4Gi` | The runner container's resources.                                                                                                                   |
| `cloudAgents.job.serviceAccountName`      |                               | none                                                    | The pod's ServiceAccount. Without one, the pod gets no API token.                                                                                   |
| `cloudAgents.job.imagePullSecrets`        |                               | `[]`                                                    | Pull secrets for a private runner image.                                                                                                            |
| `cloudAgents.job.nodeSelector`            |                               | none                                                    | A node selector for agent pods.                                                                                                                     |
| `cloudAgents.pollIntervalMs`              |                               | `2000`                                                  | How often a follower checks a pending pod.                                                                                                          |

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

### Give Backstage access to the namespace

The plugin loads the Kubernetes client configuration the standard way: `KUBECONFIG`, then `~/.kube/config`, then the in-cluster ServiceAccount. In a cluster, give Backstage's ServiceAccount this Role in the agents namespace only:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: backstage-cloud-agents
  namespace: cloud-agents
rules:
  - apiGroups: [batch]
    resources: [jobs]
    verbs: [create, get, list, watch, patch, delete]
  - apiGroups: ['']
    resources: [pods, pods/log]
    verbs: [get, list, watch]
  - apiGroups: ['']
    resources: [secrets]
    verbs: [create, get, delete]
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

### Connect GitHub through a GitHub App

Users can paste a GitHub token on the settings page. To offer **Connect with GitHub** instead, use a GitHub App with "Expire user authorization tokens" on:

1. Add `<backend.baseUrl>/api/cloud-agents/me/github/callback` to the App's callback URLs. An App can list several, so the App that signs users in to Backstage works too.
2. Give the App the repository permissions an agent needs: Contents and Pull requests (read and write), and Metadata (read). Install it on the repositories agents work on.
3. Set `cloudAgents.github.clientId` and `clientSecret`, or `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET`.

A user token from the App lasts 8 hours. The plugin stores the refresh token and refreshes the access token at the start of every run, so a run starts with 8 hours of GitHub access. Runs then push and open pull requests as the user.

The runner also clones the private skills repository `alaborderie/claude-plugins` with `GH_TOKEN` (see [runner/README.md](runner/README.md#skills)). For another organization, build the runner with a skills repository its users can read.

## Credentials and tokens

Each user sets their own credentials on **Cloud agents > Settings**, or with `PUT /me/credentials/:name`:

| Credential | Value                                                                              | The run gets                                                   |
| ---------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `claude`   | The token from `claude setup-token`.                                               | `CLAUDE_CODE_OAUTH_TOKEN`                                      |
| `codex`    | An OpenAI API key (`kind: api_key`), or a ChatGPT `auth.json` (`kind: auth_json`). | `CODEX_API_KEY`, or the file `auth.json` and `CODEX_AUTH_JSON` |
| `opencode` | An OpenCode Go API key.                                                            | `OPENCODE_API_KEY`                                             |
| `github`   | The GitHub App connection, or a token.                                             | `GH_TOKEN`                                                     |

The plugin seals each value with AES-256-GCM. The additional data is the user's entity ref and the credential name, so a sealed value copied to another user or credential does not decrypt. No route returns a value, and the plugin logs only credential names. A run's Secret holds `GH_TOKEN` and the credential of its harness, nothing else. The runner redacts these values from its output (see [runner/EVENTS.md](runner/EVENTS.md#credentials)).

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
