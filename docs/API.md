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
  "parent": { "source": "t3", "threadId": "optional", "label": "optional" }
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
  "id": "ag_...",
  "title": "...",
  "repo": "owner/name",
  "base": "main",
  "branch": "...",
  "harness": "...",
  "model": "...",
  "effort": "high",
  "status": "running",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "runs": [
    {
      "id": "run uuid",
      "status": "running|succeeded|failed|needs_input|stopped",
      "startedAt": "ISO",
      "finishedAt": null,
      "exitCode": null
    }
  ],
  "openQuestions": [
    {
      "questionId": "ask-1",
      "runId": "...",
      "question": "...",
      "options": ["..."]
    }
  ],
  "prUrl": null,
  "parent": { "source": "t3", "threadId": "..." }
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

## Additions: current activity and follow-up messages

These fields and events are additive. The API stays version 1, and clients
of the contract above ignore unknown fields and unknown event types.

- The agent object, from `GET /agents` and `GET /agents/:id`, has `activity`:
  what the agent did last, for list rows and widgets. It is `null` before the
  first tool call or assistant message.

  ```json
  {"type": "tool.call", "name": "Bash", "kind": "shell", "summary": "yarn tsc", "ts": "ISO"}
  {"type": "assistant.message", "text": "Opening the pull request.", "ts": "ISO"}
  ```

  `summary` is the call's command, file path, pattern, URL, or description.
  `text` is the message's first line. Both are at most 200 characters. `ts` is
  the runner event's `ts`.

- `POST /agents/:id/messages` adds a plugin event `agent.message`
  (`{"type": "agent.message", "text": "...", "ts": "ISO"}`) to the stream. Its
  envelope carries the `runId` of the run the message starts, and it comes
  just before that run's `agent.run_started` with `reason: "message"`. It
  replays with `Last-Event-ID` like every other event.

## Additions: hubs, children, and actions (contract for hub 2026-11-05-cloud-agents-delegation)

These additions keep the API at version 1. Clients of the contract above ignore
unknown fields, statuses, and event types. The plugin, the runner, the
`backstage-hub` skill in `alaborderie/claude-plugins`, and the future
`assistant` plugin are built against this text at the same time. None of them
changes it alone. An executant that needs a change asks the hub.

### Agent kinds and the family link

- `POST /agents` accepts `"kind": "task" | "hub"`, default `"task"`. A hub's
  `prompt` is its objective. A hub has a repo, a base, and a branch like any
  agent. Its children use them as defaults.
- The agent object gains:

  - `kind`: `"task"` or `"hub"`.
  - `parentId`: the id of the hub that created this agent, or `null`.
  - `children`: on a hub, one summary per child, oldest first. `[]` on a task.

  ```json
  {
    "id": "ag_...",
    "title": "...",
    "status": "running",
    "branch": "...",
    "prUrl": null,
    "openQuestions": 0,
    "updatedAt": "ISO"
  }
  ```

- `GET /agents` still returns every agent of the user, children included, each
  with its `parentId`. `?parentId=<id>` returns the children of one hub.
- A child belongs to the hub's owner and runs with that owner's credentials.
  The existing `parent` field (`{source, threadId, label}`) keeps its meaning,
  the T3 origin of an agent. It is unrelated to `parentId`.

### Hub lifecycle

- New agent status `waiting`. Only a hub has it. It means the hub has no
  active run, no open question of its own, and at least one child that is not
  terminal. `waiting` is not terminal, so the event stream stays open.
- When a hub run ends:
  - with a blocking question of its own: the hub is `needs_input`, as any
    agent. The user answers it in Backstage.
  - with pending wake events (below): the plugin starts the next hub run at once.
  - otherwise, when a child is not terminal: the hub is `waiting`.
  - otherwise: the hub takes the run's status (`succeeded` or `failed`).
- No hub pod lives while the hub is `waiting`. The hub's run exits after it
  dispatches work. The plugin, not the pod, waits for the children.
- `POST /agents/:id/stop` on a hub stops the hub and every child that is not
  terminal. `POST /agents/:id/messages` on a `waiting` hub starts a run with
  reason `message`, like on a terminal agent.

### Wake events

- A child wakes its hub when it reaches `needs_input`, `succeeded`, `failed`,
  or `stopped`. A stop that the hub itself requested does not wake it.
- If the hub is `waiting`, the plugin starts a new hub run with the new run
  reason `child`. It may wait up to 10 s to batch events from several children
  into one run.
- If the hub has an active run or is `needs_input`, the plugin queues the event
  and the next hub run carries it. A wake never starts a second concurrent run
  of one hub.
- A terminal hub (`succeeded`, `failed`, `stopped`) is not woken. Its children's
  events stay queued and the next run started by a message carries them.
- Each event delivered to a hub run appears in the hub's stream as a plugin
  event, just before that run's `agent.run_started`:
  `{"type": "agent.wake", "childId": "ag_...", "childStatus": "succeeded", "ts": "ISO"}`.
- `RunReason` gains `child`.

### Hub run prompt

The plugin builds every hub run's prompt as:

```text
Use the backstage-hub skill.

Objective:
<the hub's prompt>

<since the last run, one section per kind that applies:>
Wake events:
- child ag_x "<title>" is succeeded (branch <b>, PR <url or none>)
- child ag_y "<title>" is needs_input: question ask-1 "<text>" options [a, b]
Messages from the user:
- <text>
Answers from the user:
- ask-1 "<question>": <answer>
```

The wake text is a hint. The hub tools below are the source of truth, so the
skill reads children with `list_children` and `get_child` and does not parse
this text.

### Hub tools in the pod

On a hub run the runner's MCP server `cloud_agent` offers these tools next to
`ask_user`. A task run does not get them. Harness names follow the existing
pattern: `mcp__cloud_agent__create_child` (Claude Code),
`cloud_agent/create_child` (Codex), `cloud_agent_create_child` (OpenCode).

| Tool            | Input                                          | Output                                      |
| --------------- | ---------------------------------------------- | ------------------------------------------- |
| `create_child`  | `{title, prompt, tier, repo?, base?, branch?}` | the child agent object                      |
| `list_children` | `{}`                                           | `{children: [<agent object>]}`              |
| `get_child`     | `{id}`                                         | `{agent, lastMessage}`                      |
| `reply_child`   | `{id, questionId, answer}`                     | the child agent object                      |
| `message_child` | `{id, text}`                                   | the child agent object                      |
| `stop_child`    | `{id}`                                         | the child agent object                      |
| `read_state`    | `{}`                                           | `{state}`, the last JSON written, or `null` |
| `write_state`   | `{state}`                                      | `{}`                                        |

- `tier` is `flash`, `sol`, or `opus`. `repo` and `base` default to the hub's.
  `branch` defaults to `cloud-agent/<short id>`; give it to continue a branch.
- `lastMessage` is the child's last `assistant.message` text of its last run,
  at most 8000 characters, or `null`.
- `read_state` and `write_state` keep the hub's plan between runs, since no
  file survives the pod. `state` is any JSON value of at most 64 KiB.
- Every child operation refuses an id that is not a child of this hub. A tool
  error returns MCP `isError: true` with a message: `not_your_child`,
  `child_running` (the `409` of `/messages`), `missing_credential`, or the
  plugin's message.
- The run authenticates with its `CLOUD_AGENT_RUN_TOKEN`. A hub run's token
  grants exactly these operations, on the hub's own children, while the run is
  active. A task run's token still grants only `GET /runner/github-token`.

### Actions registry

`cloud-agents-backend` registers these actions in Backstage's actions registry
(`actionsRegistryServiceRef`), so `plugin-mcp-actions-backend` exposes them over
MCP and other backend plugins call them with `actionsServiceRef`. Ids are
`cloud-agents:<name>`.

| Action               | Input                                        | Output                 |
| -------------------- | -------------------------------------------- | ---------------------- |
| `create-agent`       | `{repo, prompt, tier, base?, title?, kind?}` | `{agent}`              |
| `list-agents`        | `{status?, parentId?, limit?}`               | `{agents}`             |
| `get-agent`          | `{id}`                                       | `{agent, lastMessage}` |
| `reply-to-agent`     | `{id, questionId, answer}`                   | `{agent}`              |
| `send-agent-message` | `{id, text}`                                 | `{agent}`              |
| `stop-agent`         | `{id}`                                       | `{agent}`              |

- A user principal acts on that user's agents, with the same rules and errors
  as the HTTP routes.
- `list-agents` and `get-agent` are marked read-only. The others are not.
- The pod's hub tools go through the same operations. The plugin should reach
  them through this registry (for example a custom external token handler that
  turns an active hub run token into a principal scoped to that hub's
  children). If the registry cannot carry that scope, the plugin serves the hub
  tools from run-token routes under `/runner/` that call the same functions,
  and documents the routes here.
- The `assistant` plugin will start, read, answer, and stop agents only through
  these actions, and follow an agent with `GET /agents/:id/events`.

### Interface

- The new agent form offers "Agent" or "Hub".
- The agent list shows each hub with its children nested under it.
- A hub's detail page lists its children with status, open questions, and PR
  links. A child's detail page links to its hub.

### Implementation notes

What the plugin does where the hub contract leaves room.

- The pod's hub tools go through the actions registry. A hub run's
  `CLOUD_AGENT_RUN_TOKEN` is `cahub.<run id>.<expiry>.<signature>`: an
  HMAC-SHA256 under a key derived with HKDF from `CLOUD_AGENTS_ENCRYPTION_KEY`
  (info `cloud-agents hub run token v1`), valid until the Job's
  `activeDeadlineSeconds` plus 10 minutes. The package exports
  `cloudAgentsHubRunTokens`, an external token handler. With it added to the
  backend and this config, Backstage authenticates the token as the service
  principal `cloud-agents-hub-run:<run id>`, in the `cloud-agents` plugin only:

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

  The actions accept that principal only while its run is active and belongs
  to a hub, and only on that hub's children. A task run keeps a random token
  that no Backstage handler accepts.

- The runner calls
  `POST <runnerBackendUrl>/api/cloud-agents/.backstage/actions/v1/actions/cloud-agents:<name>/invoke`
  for the six child operations. `create_child` fills `repo` and `base` with
  the hub's and sends `kind: "task"`.
- `read_state` and `write_state` are not actions, since they mean nothing to a
  user. They use run-token routes: `GET /runner/hub/state` answers
  `200 {"state": <JSON or null>}`, and `PUT /runner/hub/state`
  `{"state": <JSON>}` answers `200 {}`, or `400` above 64 KiB. Both answer
  `401` for a task run's token, an unknown token, and a finished run.
- `create-agent` also takes `branch` (optional), which `create_child` needs.
  Called by a hub run, it refuses `kind: "hub"` with `400`: a hub's children
  are tasks.
- A hub run's call on an agent that is not its child, the hub itself
  included, and `list-agents` with another `parentId`, answer
  `403 {"error": {"name": "NotAllowedError", "message": "not_your_child"}}`.
  A finished hub run's token gets `403` on every action. In actions,
  `missing_credential` is `422` with the error name `MissingCredentialError`.
- The plugin env on a hub run: `CLOUD_AGENT_KIND=hub` and
  `CLOUD_AGENT_API_URL=<runnerBackendUrl>/api/cloud-agents`. A hub needs
  `cloudAgents.runnerBackendUrl`; without it `POST /agents` with
  `kind: "hub"` answers `400`.
- A child's event waits `cloudAgents.hubWakeDelayMs` (default 5000 ms) for
  events of other children before it starts the hub's run. When a hub run
  ends with events queued, the hub shows `waiting` for a moment and the next
  run starts at once. At startup the plugin wakes every `waiting` hub that
  has events queued.
- Before a hub run's `agent.run_started` come its `agent.wake` events, oldest
  first, then the `agent.message` when the run has one.
- A hub run's prompt holds the objective and only what is new for that run.
  A wake line for a `failed` or `stopped` child has the same form as for a
  `succeeded` one. A `needs_input` child gets one line per open question.
- Stopping a hub stops its children as stops the hub requested, so they
  queue no wake event.
- When a wake finds that the owner's harness or GitHub credential is gone,
  the hub fails with that error instead of sleeping forever.

## Additions: the Anthropic API key (for the assistant plugin)

These additions keep the API at version 1.

- `GET /me/credentials` gains `"anthropic": {"set": bool, "updatedAt"}`.
- `PUT /me/credentials/anthropic` `{"value": "sk-ant-api..."}` stores the
  user's Anthropic API key, sealed like the other credentials. It answers `400`
  for a Claude Code token (`sk-ant-oat...`), which is not an API key.
  `DELETE /me/credentials/anthropic` clears it. No agent run receives it.
- `POST /service/anthropic-key` `{"userEntityRef": "user:default/..."}` answers
  `{"apiKey": "..." | null}`. It accepts only a service token whose subject is
  `plugin:assistant`; a user token or another plugin gets `403`. The assistant
  backend uses it for its reasoning tool, so the key never reaches a browser.
  [docs/ASSISTANT.md](ASSISTANT.md) describes the assistant.
