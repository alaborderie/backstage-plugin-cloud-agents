# cloud-agent event stream, version 1

`cloud-agent run` prints one JSON object per line on stdout. Each line is one event. The Backstage plugin and the T3 Code fork read this stream. [`schema/events.v1.schema.json`](schema/events.v1.schema.json) is the machine-readable contract (JSON Schema 2020-12). The image ships the same file at `/opt/cloud-agent/schema/events.v1.schema.json`.

Stdout carries only events. The runner writes harness diagnostics and skill-install logs to stderr.

## Versioning

- Every event has `"v": 1`. A change that removes or renames a field, changes a field's meaning or type, or removes an event type sets `v` to 2 and adds `events.v2.schema.json`.
- A new event type or a new field keeps `v` at 1. Consumers ignore event types and fields they do not know.
- The schema is strict (`unevaluatedProperties: false`), so it rejects fields it does not list. To validate a stream, use the schema from the image that produced it.

## Envelope

Every event has these fields, plus the fields of its `type`.

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | `1` | Event format major version. |
| `seq` | integer | Position in the run's stream. The first event is 0, and there are no gaps. |
| `ts` | string, RFC 3339 | When the runner emitted the event. |
| `run_id` | string | `--run-id`, else `$CLOUD_AGENT_RUN_ID`, else a random UUID. The same on every line of one run. |
| `type` | string | One of the event types below. |

## Order

1. `run.started` is always the first event.
2. `skills.ready` and `workspace.ready` follow, before the harness starts.
3. `session.started` comes from the harness, then any number of `assistant.message`, `tool.call`, `tool.result`, `question`, `usage`, `rate_limit`, and `log` events.
4. `run.finished` is always the last event, also when setup fails or the run is cancelled.

Two cases print no events. A usage error (exit code 2) prints a message on stderr only. A `SIGKILL` ends the process before it can print `run.finished`.

A `tool.result` follows its `tool.call`. OpenCode reports a tool only when the tool finishes, so its `tool.call` and `tool.result` arrive together. Its `tool.call` can come after a `question` that the same tool asked.

## Event types

### `run.started`

| Field | Type | Meaning |
| --- | --- | --- |
| `harness` | `claude`, `codex`, or `opencode` | `--harness`. |
| `model` | string | `--model`, passed to the harness unchanged. |
| `effort` | string | `--effort`. Claude Code gets `--effort`, Codex gets `model_reasoning_effort`, and OpenCode gets the model variant `<model>#<effort>`. |
| `repo`, `base`, `branch` | string | `--repo`, `--base`, `--branch`. |
| `runner_version` | string | The image version, such as `0.1.0+3f2c1ab`. |
| `harness_version` | string or null | First line of `<cli> --version`. |

### `skills.ready`

| Field | Type | Meaning |
| --- | --- | --- |
| `source` | string | `github.com/alaborderie/claude-plugins`. |
| `commit` | 40-hex string | The skills commit installed for this run. |

### `workspace.ready`

| Field | Type | Meaning |
| --- | --- | --- |
| `repo`, `branch`, `base` | string | As in `run.started`. |
| `head_sha` | 40-hex string | `HEAD` before the agent starts. |
| `branch_existed` | boolean | `true` when `branch` already existed on the remote, and the runner checked it out instead of creating it from `base`. |

### `session.started`

| Field | Type | Meaning |
| --- | --- | --- |
| `session_id` | string | Claude Code `session_id`, Codex `thread_id`, or OpenCode `sessionID`. |
| `model` | string or null | The model the harness reports. Only Claude Code reports one. |

### `assistant.message`

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | string | Text the agent wrote. Reasoning and thinking blocks are not included. |
| `parent_call_id` | string or null | For Claude Code subagent output, the `call_id` of the `Task` call that started the subagent. `null` for the main agent and for the other harnesses. |

### `tool.call`

| Field | Type | Meaning |
| --- | --- | --- |
| `call_id` | string | Pairs the call with its `tool.result`. |
| `name` | string | The harness's tool name: `Bash` and `mcp__cloud_agent__ask_user` (Claude Code), `shell`, `apply_patch`, and `cloud_agent/ask_user` (Codex), or `shell`, `write`, and `execute` (OpenCode). |
| `kind` | string | One of `shell`, `read`, `edit`, `search`, `web`, `mcp`, `task`, or `other`. |
| `input` | any JSON | The tool input as the harness reports it. The runner cuts each string longer than 4,000 characters and appends `…[N more chars]`. |
| `parent_call_id` | string or null | As in `assistant.message`. |

### `tool.result`

| Field | Type | Meaning |
| --- | --- | --- |
| `call_id` | string | The `call_id` of the matching `tool.call`. |
| `is_error` | boolean | The tool failed, or a shell command exited with a non-zero code. |
| `output` | string | The tool output, at most 16,000 characters. |
| `truncated` | boolean | `true` when the runner cut `output`. |
| `parent_call_id` | string or null | As in `assistant.message`. |

### `question`

| Field | Type | Meaning |
| --- | --- | --- |
| `question_id` | string | `ask-1`, `ask-2`, and so on for `ask_user`. For a native question tool, the tool's `call_id`, with `#<index>` added when one call asks several questions. |
| `question` | string | The question text. |
| `options` | array of `{label, description}` | Suggested answers, or an empty array. `description` is a string or null. |
| `blocking` | boolean | `true` when the agent stopped to wait for the answer. Always `false` for `native`. |
| `source` | `ask_user` or `native` | `ask_user` is the runner's MCP tool. `native` is the harness's own question tool (Claude Code `AskUserQuestion`, OpenCode `question`), which a headless run cancels. |

See [Questions](#questions) for what happens after a question.

### `usage`

Token counts since the previous `usage` event. The sum of all `usage` events is `run.finished.usage`.

| Field | Type | Meaning |
| --- | --- | --- |
| `input_tokens` | integer | All input tokens, cached tokens included. |
| `output_tokens` | integer | Output tokens. |
| `cached_input_tokens` | integer | The part of `input_tokens` read from the prompt cache. |
| `reasoning_tokens` | integer | Thinking or reasoning tokens, when the harness reports them. |
| `cost_usd` | number or null | The cost the harness reports. Claude Code reports a list-price cost. OpenCode reports a cost per step, which is 0 under an OpenCode Go subscription. Codex reports none (`null`). |

Claude Code reports usage once, at the end of the run. Codex reports it once per turn. OpenCode reports it once per model step.

### `rate_limit`

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `allowed`, `warning`, or `limited` | `limited` means the provider refused or throttled a request. |
| `window` | string or null | The limit window when the harness names it, such as `five_hour`. |
| `resets_at` | RFC 3339 string or null | When the window resets. |
| `utilization` | number or null | The used fraction of the window, from 0. |
| `message` | string or null | The provider's error message, for `limited`. |

Claude Code sends a `rate_limit` event with its subscription status during every run. Codex and OpenCode report rate limits only as errors, so the runner emits `limited` when a harness error message names a rate or usage limit or an HTTP 429.

### `log`

| Field | Type | Meaning |
| --- | --- | --- |
| `level` | `info`, `warn`, or `error` | |
| `source` | `runner` or `harness` | `harness` for harness error events and for stdout lines that are not JSON. |
| `message` | string | |

### `run.finished`

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | string | See the status table below. |
| `exit_code` | `0`, `1`, `3`, or `130` | The runner's process exit code. |
| `harness_exit_code` | integer or null | The harness process exit code, or `null` when the harness did not start. |
| `branch` | string | `--branch`. |
| `head_sha` | 40-hex string or null | `HEAD` of the working copy after the agent stopped. |
| `pushed` | boolean | `true` when the remote branch points at `head_sha`. |
| `pr_url` | string or null | The newest pull request whose head is `branch`, in any state. Without one, the newest pull request on another branch the run pushed that is open or was opened during the run. See [The end of a run](#the-end-of-a-run). |
| `open_questions` | array of string | `question_id` of each blocking question. |
| `usage` | object | The sum of the run's `usage` events, with the fields of `usage`. |
| `duration_ms` | integer | From process start to this event. |
| `error` | string or null | Why the run failed or was cancelled. |

| `status` | `exit_code` | When |
| --- | --- | --- |
| `succeeded` | 0 | The harness exited with code 0, reported success, and the agent asked no blocking question. |
| `failed` | 1 | Setup failed (missing credential, skills install, clone), the harness exited with a non-zero code, or the harness reported an error. |
| `needs_input` | 3 | The run otherwise succeeded, and the agent asked at least one blocking question. |
| `cancelled` | 130 | The runner received `SIGTERM` or `SIGINT`. It stops the harness with `SIGTERM`, then reports. |

### The end of a run

Before it prints `run.finished`, the runner does two things.

1. Unless the run was cancelled, it pushes the checked-out branch when that branch has commits that no remote branch has. It commits nothing, never forces, and never pushes `--base` or the repository's default branch. A `log` event reports the push, a failed push, or the commits it left. The run's `status` does not change.
2. It looks for the run's pull request with `gh pr list`. It first asks for pull requests whose head is `branch`. Then it asks for each other branch the run pushed: a branch whose remote-tracking ref has an `update by push` reflog entry since the run started. A branch that another agent pushed, and that this run only fetched, does not count.

Runner versions before this change set `pr_url` only from `branch`. The change keeps `v` at 1: `pr_url` keeps its type, and when `branch` has a pull request it names the same one. A consumer that needs the head branch of `pr_url` reads it from the pull request.

## Questions

The runner registers one MCP server, `cloud_agent`, with every harness. It has one tool, `ask_user`, with the input `{question, options?, blocking?}`. `blocking` defaults to `true`. The tool description tells the agent to use `ask_user` wherever a skill says to ask the user.

When the agent calls `ask_user`, the MCP server sends the question to the runner over a Unix socket, and the runner emits a `question` event. In version 1, no one answers during the run. The tool returns at once and tells the agent what to do next:

- For a blocking question, the agent stops, summarizes its progress, and ends its turn. The run ends as `needs_input`, and `open_questions` lists the question.
- For a non-blocking question, the agent continues with the default it stated.

To answer a blocking question, start a new run with the same `--repo` and `--branch`, and put the original brief, the question, and the answer in the prompt file. The new run checks out the existing branch (`workspace.ready.branch_existed` is `true`), so the agent continues from the pushed commits. The run that asked pushed the agent's unpushed commits before it ended (see [The end of a run](#the-end-of-a-run)).

The socket carries one JSON line per tool call, `{"tool": "ask_user", "input": {...}}`, and one reply line, `{"text": "...", "isError": false}`, which becomes the tool result. In version 1 the reply to `ask_user` never holds an answer. A later version can hold the reply until an operator answers, and the agent then gets the answer as the tool result in the same run. That change does not change the event format.

### Hub tools

On a hub run, when the plugin sets `CLOUD_AGENT_KIND=hub` and `CLOUD_AGENT_API_URL`, the `cloud_agent` server also offers `create_child`, `list_children`, `get_child`, `reply_child`, `message_child`, `stop_child`, `read_state`, and `write_state` ([docs/API.md](../docs/API.md#hub-tools-in-the-pod)). The MCP server sends each call over the same socket. The runner makes the call to the plugin with `CLOUD_AGENT_RUN_TOKEN`, so the token never reaches the harness. The calls show up as ordinary `tool.call` and `tool.result` events, for example `mcp__cloud_agent__create_child`. A task run does not list them.

## Credentials

The runner replaces every occurrence of a credential value with `[REDACTED]` in each event, in the `--raw-out` file, and on stderr. The credentials are the values of `GH_TOKEN`, `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENCODE_API_KEY`, and `CLOUD_AGENT_RUN_TOKEN`, and every string of eight or more characters in the file that `CODEX_AUTH_JSON` names. The runner also redacts every string in a GitHub token format (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, or `github_pat_` and at least 20 more characters), because a token fetched during the run is in no variable.

## Mapping from each harness

| Normalized event | Claude Code (`-p --output-format stream-json --verbose`) | Codex (`exec --json`) | OpenCode (`run --format json`) |
| --- | --- | --- | --- |
| `session.started` | `system` with `subtype: init` | `thread.started` | the first line's `sessionID` |
| `assistant.message` | `assistant` content block `text` | `item.completed` with `agent_message` | `text` |
| `tool.call` | `assistant` content block `tool_use` | `item.started` (or `item.completed`) with `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, or `collab_tool_call` | `tool_use` |
| `tool.result` | `user` content block `tool_result` | `item.completed` of the same item | `tool_use` (`state.output` or `state.error`) |
| `usage` | `result.usage` and `result.total_cost_usd` | `turn.completed.usage` | `step_finish.part.tokens` and `part.cost` |
| `rate_limit` | `rate_limit_event` | `error` that names a limit | `error` with status 429 or that names a limit |
| `log` | none | `error`, `turn.failed`, and `item.completed` with `error` | `error` |
| failure | `result` with `is_error` or a `subtype` other than `success`, or no `result` | `turn.failed` or `error` without a later `turn.completed`, or no `turn.completed` | `error` |

The runner ignores other native lines, such as Claude Code thinking blocks, Codex `reasoning` and `todo_list` items, and OpenCode `step_start`. The `--raw-out` file keeps every native line.
