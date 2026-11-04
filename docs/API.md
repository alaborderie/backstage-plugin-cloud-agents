# Cloud agents API, version 1 (contract for hub 2026-11-04-cloud-agents-product)

The Backstage plugin `backstage-plugin-cloud-agents` serves this API. The T3 ACP
bridge `t3-cloud-agents-acp` consumes it. Both are built against this text at
the same time, so neither may change it alone; an executant that needs a change
asks the hub. The plugin commits this contract as `docs/API.md`.

Base URL: `<backstage>/api/cloud-agents`. All bodies are JSON.

## Auth

- Backstage frontend: the normal Backstage user credentials.
- External clients (the T3 bridge): `Authorization: Bearer cat_<random>`, a
  personal access token the user creates in their Backstage profile. The plugin
  stores only a hash, shows the token once, and resolves it to the user's
  entity ref. Every route below acts as that user and only sees that user's
  agents.

## Agents and runs

An **agent** is one task on one branch. It owns one or more **runs**: one
Kubernetes Job of `ghcr.io/alaborderie/cloud-agent-runner` each. A follow-up
message or an answer to a blocking question starts a new run on the same
branch (the runner's v1 rule, see `runner/EVENTS.md` "Questions").

Agent status: `queued | running | needs_input | succeeded | failed | stopped`.

### POST /agents

```json
{
  "repo": "owner/name",
  "base": "main",
  "branch": "optional; default cloud-agent/<short id>",
  "prompt": "full brief",
  "title": "optional",
  "tier": "flash | sol | opus",
  "harness": "claude | codex | opencode",
  "model": "slug",
  "effort": "high",
  "parent": {"source": "t3", "threadId": "optional", "label": "optional"}
}
```

Give `tier`, or `harness` + `model` (+ `effort`). The plugin resolves a tier
from app-config `cloudAgents.tiers` (default: flash -> opencode
`opencode-go/deepseek-v4.1-flash`, sol -> codex GPT Sol, opus -> claude Opus,
all effort `high`). The run uses the calling user's stored credential for that
harness; a missing one returns `422 {"error": "missing_credential", "harness": ...}`.

Response `201`: the agent object.

### Agent object

```json
{
  "id": "ag_...", "title": "...", "repo": "owner/name", "base": "main",
  "branch": "...", "harness": "...", "model": "...", "effort": "high",
  "status": "running", "createdAt": "ISO", "updatedAt": "ISO",
  "runs": [{"id": "run uuid", "status": "running|succeeded|failed|needs_input|stopped", "startedAt": "ISO", "finishedAt": null, "exitCode": null}],
  "openQuestions": [{"questionId": "ask-1", "runId": "...", "question": "...", "options": ["..."]}],
  "prUrl": null,
  "parent": {"source": "t3", "threadId": "..."}
}
```

### GET /agents, GET /agents/:id

List (newest first, `?status=` filter) and read.

### GET /agents/:id/events (Server-Sent Events)

- Each SSE message: `id: <agent seq>` (integer, increasing across all runs of
  the agent), `event: agent-event`, `data: {"seq": n, "runId": "...", "event": <runner event v1, unchanged>}`.
- Plugin events use the same envelope with `event.type` in the `agent.*`
  namespace: `agent.status` (`{status}`), `agent.run_started` (`{runId, reason: "initial|reply|message"}`).
- Resume with `Last-Event-ID` or `?after=<seq>`: the plugin replays stored
  events after that seq, then streams live ones.
- When the agent reaches a terminal status (`succeeded | failed | stopped`) the
  plugin sends that last `agent.status` and closes the stream. `needs_input` is
  not terminal.
- A comment line (`: ping`) at least every 25 s.

### POST /agents/:id/reply

`{"questionId": "ask-1", "answer": "text"}` -> `202`. When every open question
of the last run has an answer, the plugin starts the next run on the same
branch with the original prompt, the questions, and the answers.

### POST /agents/:id/messages

`{"text": "..."}` -> `202`. Starts a follow-up run on the same branch (used for
retries). `409` while a run is active.

### POST /agents/:id/stop

`202`. Deletes the active Job (the runner reports `cancelled`, exit 130) and
sets the agent to `stopped`.

## Profile: credentials and tokens

- `GET /me/credentials` -> `{"claude": {"set": bool, "updatedAt"}, "codex": {"set": bool, "kind": "api_key|auth_json"}, "opencode": {"set": bool}, "github": {"connected": bool, "login": "..."}}`. Values are never returned.
- `PUT /me/credentials/claude|codex|opencode` `{"value": "...", "kind": "api_key|auth_json"}` (kind only for codex), `DELETE` the same paths.
- `GET /me/github/connect` starts the GitHub App user authorization (web flow
  with the App's client id and secret); its callback stores the user's
  access and refresh tokens encrypted. Runs push as that user.
- `POST /me/tokens` `{"name": "..."}` -> `{"id", "token"}` (token shown once),
  `GET /me/tokens`, `DELETE /me/tokens/:id`.

Credentials are encrypted at rest with AES-256-GCM using the key in env
`CLOUD_AGENTS_ENCRYPTION_KEY` (base64, 32 bytes). Each run gets its own
Kubernetes Secret with only the harness credential it needs plus `GH_TOKEN`,
owned by the Job so it is deleted with it.

## Deployment env (set by k3s-ovh-config)

`AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET` (the GitHub App's OAuth
credentials, also used by `/me/github/connect`), `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `CLOUD_AGENTS_ENCRYPTION_KEY`,
`CLOUD_AGENTS_NAMESPACE` (`cloud-agents`), `CLOUD_AGENTS_RUNNER_IMAGE`,
`BACKEND_SECRET`, `POSTGRES_HOST|PORT|USER|PASSWORD`. Backstage runs in-cluster
with a ServiceAccount allowed to manage Jobs, Pods, Pods/log, and Secrets in
`CLOUD_AGENTS_NAMESPACE` only.

## Additions granted by the hub (2026-11-04 13:50 UTC)

- `PUT /me/credentials/github {"value": "<token>"}` stores a GitHub token directly (no refresh), for dev setups and Backstages without a GitHub App; `GET /me/credentials` then reports `github: {connected: true, login}`.
- `DELETE /me/credentials/github` disconnects GitHub.
The T3 bridge does not call these routes.

## Additions approved by the hub

These routes are additive. Clients of the contract above do not need them.

- `PUT /me/credentials/github` `{"value": "<token>"}` stores a GitHub token
  (a personal access token or a user token) for Backstages without a GitHub
  App and for local development. The plugin checks it with `GET /user` and
  answers `400` when GitHub rejects it. `GET /me/credentials` then reports
  `{"connected": true, "login": "...", "method": "token"}`. The plugin never
  refreshes such a token.
- `DELETE /me/credentials/github` disconnects GitHub, whichever way it was
  connected.

## Additions: runner credential endpoint

This route is for runner pods. Clients of the contract above do not call it.

- `GET /runner/github-token` with `Authorization: Bearer <CLOUD_AGENT_RUN_TOKEN>`
  answers `200 {"token": "<GitHub token>"}` with `Cache-Control: no-store`.
  The token is the run owner's current GitHub token. The plugin refreshes a
  GitHub App user token first when it expires within 10 minutes.
- Each run gets a random credential token in its Secret as
  `CLOUD_AGENT_RUN_TOKEN`. The plugin stores only its SHA-256 hash and never
  logs it.
- The route answers `401` without a token, for an unknown token, for a `cat_`
  access token, and once the run is no longer active (it succeeded, failed,
  needs input, or stopped).
- It answers `422 missing_credential` when the owner's GitHub credential is
  gone or can no longer be refreshed.
- The pod finds the route through `CLOUD_AGENT_GH_TOKEN_URL`, which the plugin
  sets to `<cloudAgents.runnerBackendUrl>/api/cloud-agents/runner/github-token`
  when that config key is set.

A run start no longer refreshes the GitHub token every time. It refreshes the
token only when it would expire before the run's `activeDeadlineSeconds` plus
10 minutes, or when GitHub rejects it, one refresh at a time per user. The
Secret's `GH_TOKEN` is unchanged otherwise.

## Implementation notes

What the plugin does where the contract leaves room. Each item only adds a
field or fixes a status code.

- `GET /me/credentials` also returns `updatedAt` for each harness, and
  `github.method` (`oauth` or `token`), `github.updatedAt`, and
  `github.connectAvailable` (whether a GitHub App is configured).
- `PUT` and `DELETE /me/credentials/...` answer `200` with the same object as
  `GET /me/credentials`.
- `422 missing_credential` also has `credential`: the harness name, or
  `github` when the GitHub credential is missing or can no longer be
  refreshed.
- Plugin events carry `ts`. An `agent.status` of `failed` that the plugin
  decided (the Job could not start, or the pod vanished without
  `run.finished`) carries `error`.
- The SSE stream starts with the comment `: connected`, then `: ping` every
  15 s. Seqs start at 1, so `Last-Event-ID: 0` replays everything.
- `POST /agents/:id/reply`, `/messages`, and `/stop` answer `202` with the
  agent object. `/reply` answers `409` when the agent is not `needs_input` or
  the question already has an answer, and `404` for an unknown question.
  `/stop` on a terminal agent answers `202` and changes nothing.
- `GET /me/github/connect` answers `302` to GitHub, or `200 {"url": "..."}`
  when the request accepts `application/json` (the frontend uses that). The
  GitHub App's callback URL is `<backstage>/api/cloud-agents/me/github/callback`.
  The callback sends the browser to `<app>/cloud-agents/settings?github=connected`
  (or `failed`, `denied`).
- `POST /me/tokens` answers `201`; `DELETE /me/tokens/:id` answers `204`.
  `GET /me/tokens` returns `[{"id", "name", "createdAt", "lastUsedAt"}]`.
- Errors other than `422` use Backstage's error body:
  `{"error": {"name", "message"}, "response": {"statusCode"}}`.
